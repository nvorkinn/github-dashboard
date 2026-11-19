import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import type { PendingSnapshot } from "../../shared/pending.ts";
import type { Notice } from "./notices.ts";
import { createPendingReleases, PENDING_FILE } from "./pending_releases.ts";
import { fakeApp, settle } from "./testing.ts";

afterEach(() => {
  vi.useRealTimers();
});

const APP = "octo/app";
const LIB = "octo/lib";
const sha = (n: number) => `${n}`.padStart(40, "c");

/** GitHub as users: `token` may push to `push`, and sees these pull requests as `state`. */
function userGitHub(pulls: Record<string, { state: string; title?: string }>, push = [APP]) {
  const asked: string[] = [];
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const path = url.pathname.slice(1);
    asked.push(path);
    const auth = new Headers(init?.headers).get("Authorization");
    if (auth !== "Bearer user-token") {
      return new Response("", { status: 401 });
    }
    if (path === "user") {
      return Response.json({ login: "nikolai" });
    }
    const repo = /^repos\/([^/]+\/[^/]+)$/.exec(path)?.[1];
    if (repo) {
      return Response.json({ full_name: repo, permissions: { push: push.includes(repo) } });
    }
    const pull = /^repos\/([^/]+\/[^/]+)\/pulls\/(\d+)$/.exec(path);
    const found = pull && pulls[`${pull[1]}#${pull[2]}`];
    if (found) {
      return Response.json({ state: found.state, title: found.title ?? `Pull ${pull[2]}` });
    }
    return new Response("", { status: 404 });
  }) as typeof fetch;
  return { fetcher, asked };
}

function setUp(
  routes: Record<string, unknown> = {},
  options: {
    dataDir?: string;
    pulls?: Record<string, { state: string }>;
    installed?: string[];
    recheckMs?: number;
  } = {},
) {
  const installed = options.installed ?? [APP, LIB];
  const fake = fakeApp(
    installed.map((repo) => ({ repo })),
    { [`repos/${APP}`]: { default_branch: "main" }, ...routes },
  );
  const user = userGitHub(options.pulls ?? { [`${APP}#1`]: { state: "open" }, [`${LIB}#2`]: { state: "open" } });
  const told: PendingSnapshot[] = [];
  const notices: Notice[] = [];
  const closing = new AbortController();
  const pending = createPendingReleases({
    app: fake.app,
    installationOf: (repo) => (installed.includes(repo) ? 1 : undefined),
    reposKnown: Promise.resolve(),
    dataDir: options.dataDir,
    publicOrigin: "https://dash.example",
    fetch: user.fetcher,
    onSnapshot: (snapshot) => told.push(snapshot),
    notify: (notice) => notices.push(notice),
    closing: closing.signal,
    recheckMs: options.recheckMs,
  });
  return { ...fake, pending, told, notices, user, closing };
}

function ask(
  pending: ReturnType<typeof createPendingReleases>,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
) {
  return pending.routes.request(path, {
    method,
    headers: {
      Authorization: "Bearer user-token",
      "Sec-Fetch-Site": "same-origin",
      "Content-Type": "application/json",
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

const both = {
  repo: APP,
  pulls: [
    { repo: APP, number: 1 },
    { repo: LIB, number: 2 },
  ],
};

function closed(repo: string, number: number, merged: boolean, at = "2026-11-19T10:00:00Z") {
  return {
    action: "closed",
    repository: { full_name: repo },
    pull_request: {
      number,
      merged,
      merge_commit_sha: merged ? sha(number) : null,
      merged_at: merged ? at : null,
      base: { ref: "main" },
    },
  };
}

test("a pending release waits for every pull request, then publishes the next minor of the last merge commit", async () => {
  const made: unknown[] = [];
  const { pending, notices, calls } = setUp({
    [`repos/${APP}/releases`]: [
      { tag_name: "v1.4.0" },
      { tag_name: "v1.4.0-rc.1" },
      { tag_name: "v9.0.0", draft: true },
    ],
    [`POST repos/${APP}/releases`]: (body: unknown) => {
      made.push(body);
      return { html_url: `https://github.com/${APP}/releases/tag/v1.5.0` };
    },
  });
  await pending.ready;

  const answer = await ask(pending, "POST", "/", both);
  expect(answer.status).toBe(200);
  const [one] = pending.snapshot().pending;
  expect(one).toMatchObject({
    repo: APP,
    by: "nikolai",
    state: "waiting",
    pulls: [
      { repo: APP, number: 1, title: "Pull 1" },
      { repo: LIB, number: 2, title: "Pull 2" },
    ],
  });

  // The project's own pull request merges first; the release waits for the library's.
  pending.onWebhook("pull_request", closed(APP, 1, true));
  await settle();
  expect(pending.snapshot().pending[0]?.state).toBe("waiting");
  expect(made).toEqual([]);

  pending.onWebhook("pull_request", closed(LIB, 2, true, "2026-11-19T11:00:00Z"));
  await settle();
  expect(made).toEqual([
    {
      tag_name: "v1.5.0",
      // The project's own merge, not whatever the default branch has by now.
      target_commitish: sha(1),
      generate_release_notes: true,
      draft: false,
      prerelease: false,
    },
  ]);
  expect(calls).toContain(`repos/${APP}/git/ref/tags/v1.5.0`);
  expect(pending.snapshot().pending[0]).toMatchObject({
    state: "released",
    tag: "v1.5.0",
    url: `https://github.com/${APP}/releases/tag/v1.5.0`,
  });
  expect(notices).toEqual([
    expect.objectContaining({
      type: "release",
      repo: APP,
      headline: `Released ${APP} v1.5.0 after #1, lib#2 merged`,
      url: `https://github.com/${APP}/releases/tag/v1.5.0`,
    }),
  ]);
});

test("a pull request closing without merging cancels the release, and says so", async () => {
  const { pending, notices, calls } = setUp();
  await ask(pending, "POST", "/", both);
  pending.onWebhook("pull_request", closed(LIB, 2, false));
  await settle();
  expect(pending.snapshot().pending[0]).toMatchObject({
    state: "cancelled",
    problem: "lib#2 was closed without merging.",
  });
  expect(notices[0]).toMatchObject({
    headline: `Release of ${APP} cancelled: lib#2 closed without merging`,
    url: `https://github.com/${LIB}/pull/2`,
  });
  // The other one merging later does nothing.
  pending.onWebhook("pull_request", closed(APP, 1, true));
  await settle();
  expect(calls.filter((call) => call.startsWith("POST"))).toEqual([]);
});

test("a merge whose webhook never came is found when the pull requests are read again", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  const { pending, calls, routes, closing } = setUp(
    { [`repos/${APP}/releases`]: [{ tag_name: "v2.0.0" }], [`repos/${APP}/pulls/1`]: { state: "open" } },
    { recheckMs: 1000 },
  );
  await pending.ready;
  await ask(pending, "POST", "/", { repo: APP, pulls: [{ repo: APP, number: 1 }] });
  routes[`repos/${APP}/pulls/1`] = {
    state: "closed",
    merged: true,
    merge_commit_sha: sha(1),
    merged_at: "2026-11-19T10:00:00Z",
    base: { ref: "main" },
  };
  routes[`POST repos/${APP}/releases`] = { html_url: `https://github.com/${APP}/releases/tag/v2.1.0` };
  vi.advanceTimersByTime(1000);
  await settle();
  expect(calls).toContain(`POST repos/${APP}/releases`);
  expect(pending.snapshot().pending[0]).toMatchObject({ state: "released", tag: "v2.1.0" });
  closing.abort();
});

test("the pending releases last through a restart, and one left half-way is published then", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "pending-"));
  const first = setUp({}, { dataDir });
  await ask(first.pending, "POST", "/", { repo: APP, pulls: [{ repo: APP, number: 1 }] });
  await settle();
  const saved = JSON.parse(readFileSync(join(dataDir, PENDING_FILE), "utf8"));
  expect(saved).toMatchObject([{ repo: APP, state: "waiting" }]);
  first.closing.abort();

  // While the relay was down, the pull request merged.
  const second = setUp(
    {
      [`repos/${APP}/pulls/1`]: {
        state: "closed",
        merged: true,
        merge_commit_sha: sha(1),
        merged_at: "2026-11-19T10:00:00Z",
        base: { ref: "main" },
      },
      [`repos/${APP}/releases`]: [{ tag_name: "v2.0.0" }],
      [`POST repos/${APP}/releases`]: { html_url: `https://github.com/${APP}/releases/tag/v2.1.0` },
    },
    { dataDir },
  );
  await second.pending.ready;
  await settle();
  expect(second.calls).toContain(`POST repos/${APP}/releases`);
  expect(second.pending.snapshot().pending[0]).toMatchObject({ state: "released", tag: "v2.1.0" });
  second.closing.abort();
});

test("a tag that exists already fails the release, which then waits for the user", async () => {
  const { pending, notices, calls } = setUp({
    [`repos/${APP}/releases`]: [{ tag_name: "v1.0.0" }],
    [`repos/${APP}/git/ref/tags/v1.1.0`]: { ref: "refs/tags/v1.1.0" },
  });
  await ask(pending, "POST", "/", { repo: APP, pulls: [{ repo: APP, number: 1 }] });
  pending.onWebhook("pull_request", closed(APP, 1, true));
  await settle();
  expect(pending.snapshot().pending[0]).toMatchObject({
    state: "failed",
    problem: "Tag v1.1.0 already exists. Resolve it on GitHub, then release by hand.",
  });
  expect(notices[0]?.headline).toMatch(/^Release of octo\/app failed: Tag v1.1.0 already exists/);
  expect(calls.filter((call) => call.startsWith("POST"))).toEqual([]);
});

test("GitHub not answering leaves the release to be tried again at the next recheck", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  const { pending, routes, notices, closing } = setUp(
    { [`repos/${APP}/releases`]: [{ tag_name: "v1.0.0" }], [`POST repos/${APP}/releases`]: 502 },
    { recheckMs: 1000 },
  );
  await pending.ready;
  await ask(pending, "POST", "/", { repo: APP, pulls: [{ repo: APP, number: 1 }] });
  pending.onWebhook("pull_request", closed(APP, 1, true));
  await settle();
  expect(pending.snapshot().pending[0]).toMatchObject({ state: "releasing", tag: "v1.1.0" });
  expect(notices).toEqual([]);

  // The tag it settled on is kept: the next try first looks whether that release is out already.
  routes[`POST repos/${APP}/releases`] = { html_url: `https://github.com/${APP}/releases/tag/v1.1.0` };
  vi.advanceTimersByTime(1000);
  await settle();
  expect(pending.snapshot().pending[0]).toMatchObject({ state: "released", tag: "v1.1.0" });
  closing.abort();
});

test("setting one up again changes what it waits for; cancelling ends it and a second delete forgets it", async () => {
  const { pending } = setUp();
  await ask(pending, "POST", "/", both);
  const answer = await ask(pending, "POST", "/", { repo: APP, pulls: [{ repo: LIB, number: 2 }] });
  const { pending: after } = (await answer.json()) as PendingSnapshot;
  expect(after).toHaveLength(1);
  expect(after[0]?.pulls.map((pull) => pull.number)).toEqual([2]);

  const id = after[0]?.id ?? "";
  expect((await ask(pending, "DELETE", `/${id}`)).status).toBe(200);
  expect(pending.snapshot().pending[0]).toMatchObject({ state: "cancelled", problem: "Cancelled by nikolai." });
  expect((await ask(pending, "DELETE", `/${id}`)).status).toBe(200);
  expect(pending.snapshot().pending).toEqual([]);
});

test("only the signed-in user who may push, from the page, can set one up, of open pull requests the app reaches", async () => {
  const { pending } = setUp(
    {},
    { pulls: { [`${APP}#1`]: { state: "closed" }, [`${LIB}#2`]: { state: "open" } }, installed: [APP, LIB] },
  );
  const text = async (answer: Response) => [answer.status, await answer.text()];

  expect(await text(await ask(pending, "POST", "/", both, { Authorization: "" }))).toEqual([401, "Sign in first."]);
  expect(await text(await ask(pending, "POST", "/", both, { "Sec-Fetch-Site": "cross-site" }))).toEqual([
    403,
    "Cross-site request refused",
  ]);
  expect(await text(await ask(pending, "POST", "/", { repo: LIB, pulls: [{ repo: LIB, number: 2 }] }))).toEqual([
    403,
    `You can't release ${LIB}: it takes write access.`,
  ]);
  expect(await text(await ask(pending, "POST", "/", both))).toEqual([400, "#1 isn't open any more."]);
  expect(
    await text(await ask(pending, "POST", "/", { repo: APP, pulls: [{ repo: "octo/elsewhere", number: 3 }] })),
  ).toEqual([400, "The GitHub App isn't installed on octo/elsewhere, so the relay can't follow it."]);
  expect(await text(await ask(pending, "POST", "/", { repo: APP, pulls: [] }))).toEqual([
    400,
    "Pick between 1 and 20 pull requests.",
  ]);
  expect(pending.snapshot().pending).toEqual([]);
});

test("without the GitHub App nothing can be set up", async () => {
  const pending = createPendingReleases({
    app: undefined,
    installationOf: () => undefined,
    reposKnown: Promise.resolve(),
    onSnapshot: () => {},
    notify: () => {},
  });
  expect(pending.snapshot()).toEqual({ configured: false, pending: [] });
  expect((await ask(pending, "POST", "/", both)).status).toBe(503);
});
