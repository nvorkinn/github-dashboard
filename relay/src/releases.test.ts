import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { createApp } from "./app.ts";
import { webhookSignature } from "./crypto.ts";
import { blob, settle, until } from "./testing.ts";

const SECRET = "webhook-secret";
const REPO = "nvorkinn/countdown";
const PATH = ".github/workflows/ship.yml";
const staticRoot = mkdtempSync(join(tmpdir(), "relay-static-"));
const githubApp = {
  appId: "123456",
  privateKey: generateKeyPairSync("rsa", { modulusLength: 2048 })
    .privateKey.export({ type: "pkcs1", format: "pem" })
    .toString(),
};

afterEach(() => {
  vi.restoreAllMocks();
});

/** A fake api.github.com with one repository, whose one workflow is marked as a release and has a run going. */
function fakeGitHub() {
  const answers: Record<string, unknown> = {
    "/app/installations": [{ id: 1 }],
    "/app/installations/1/access_tokens": { token: "ghs_SECRET", expires_at: "2999-01-01T00:00:00Z" },
    "/installation/repositories": { repositories: [{ full_name: REPO, default_branch: "main" }] },
    [`/repos/${REPO}/contents/.github/workflows`]: [{ type: "file", path: PATH, sha: "s1" }],
    [`/repos/${REPO}/git/blobs/s1`]: blob("name: Ship\n# dashboard: release\njobs:\n  build:\n    runs-on: x\n"),
    [`/repos/${REPO}/actions/workflows`]: {
      workflows: [
        { id: 1, path: PATH, name: "Ship", state: "active" },
        { id: 2, path: ".github/workflows/promote.yml", name: "Promote", state: "active" },
      ],
    },
    [`/repos/${REPO}/actions/workflows/1/runs`]: { workflow_runs: [run(5, "in_progress")] },
    [`/repos/${REPO}/actions/runs/5/jobs`]: { jobs: [job(1, "in_progress")] },
  };
  const paths: string[] = [];
  const fetcher = (async (url: string | URL | Request) => {
    const { hostname, pathname } = new URL(String(url));
    paths.push(pathname);
    const found = hostname === "api.github.com" ? answers[pathname] : undefined;
    return found === undefined ? new Response("", { status: 404 }) : Response.json(found);
  }) as typeof fetch;
  /** Resolves once the relay has read everything it reads at its start. */
  const started = async () => {
    await until(() => paths.includes(`/repos/${REPO}/actions/runs/5/jobs`));
    await settle();
  };
  return { fetcher, answers, started };
}

function run(id: number, status: string) {
  return {
    id,
    name: "Ship",
    display_title: "Ship it",
    html_url: `https://github.com/${REPO}/actions/runs/${id}`,
    status,
    conclusion: status === "completed" ? "success" : null,
    created_at: "2026-11-14T12:00:00Z",
    updated_at: "2026-11-14T12:05:00Z",
    path: PATH,
    run_attempt: 1,
  };
}

function job(id: number, status: string) {
  return {
    id,
    run_id: 5,
    run_attempt: 1,
    name: "build",
    status,
    conclusion: status === "completed" ? "success" : null,
  };
}

/** The events a stream has sent so far, by name, with their data read. */
async function events(response: Response, count: number): Promise<{ name: string; data: unknown }[]> {
  const reader = (response.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let text = "";
  const found = () =>
    [...text.matchAll(/event: (\w+)\ndata: (.*)\n\n/g)].map((match) => ({
      name: match[1] ?? "",
      data: JSON.parse(match[2] ?? "null") as unknown,
    }));
  while (found().length < count) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    text += decoder.decode(value, { stream: true });
  }
  void reader.cancel();
  return found();
}

function post(app: ReturnType<typeof createApp>, kind: string, payload: unknown) {
  const body = JSON.stringify(payload);
  return app.request("/api/github/webhook", {
    method: "POST",
    headers: { "X-GitHub-Event": kind, "X-Hub-Signature-256": webhookSignature(SECRET, Buffer.from(body)) },
    body,
  });
}

test("a page that connects is told every release run the relay read at its start, then each run as it changes", async () => {
  const github = fakeGitHub();
  const closing = new AbortController();
  const app = createApp({
    staticRoot,
    webhookSecret: SECRET,
    githubApp,
    fetch: github.fetcher,
    closing: closing.signal,
  });
  await github.started();

  const stream = await app.request("/api/events");
  const repository = { full_name: REPO, default_branch: "main" };
  await post(app, "workflow_job", { action: "completed", repository, workflow_job: job(1, "completed") });
  await settle();
  await post(app, "workflow_run", { action: "completed", repository, workflow_run: run(5, "completed") });
  await settle();

  const [hello, releases, afterJob, afterRun] = await events(stream, 7).then((all) =>
    all.filter((event) => event.name !== "change" && event.name !== "notice"),
  );
  expect(hello?.name).toBe("hello");
  expect(releases).toMatchObject({
    name: "releases",
    data: {
      configured: true,
      projects: { [REPO]: { promoteWorkflow: 2 } },
      runs: [{ repo: REPO, id: 5, workflow: "Ship", state: "running", jobs: [{ id: 1, state: "running" }] }],
    },
  });
  expect(afterJob).toMatchObject({
    name: "run",
    data: { id: 5, state: "running", graph: { nodes: [{ key: "build", jobs: [{ id: 1, state: "passed" }] }] } },
  });
  expect(afterRun).toMatchObject({ name: "run", data: { id: 5, state: "passed", jobs: [] } });
  closing.abort();
});

test("a workflow marked as a release gets its notice whatever its name, and the token is never logged", async () => {
  const logs = [
    vi.spyOn(console, "log").mockImplementation(() => {}),
    vi.spyOn(console, "warn").mockImplementation(() => {}),
  ];
  const github = fakeGitHub();
  // One read fails, so there is something to log.
  github.answers[`/repos/${REPO}/actions/runs/5/jobs`] = undefined;
  const closing = new AbortController();
  const app = createApp({
    staticRoot,
    webhookSecret: SECRET,
    githubApp,
    fetch: github.fetcher,
    closing: closing.signal,
  });
  await github.started();

  const stream = await app.request("/api/events");
  const repository = { full_name: REPO };
  await post(app, "workflow_run", { action: "completed", repository, workflow_run: run(5, "completed") });
  await settle();
  const notice = (await events(stream, 5)).find((event) => event.name === "notice");
  expect(notice?.data).toMatchObject({ type: "release", headline: `Ship in ${REPO}: success` });

  const logged = logs.flatMap((log) => log.mock.calls.flat()).join("\n");
  expect(logged).toContain(`release runs of ${REPO} not read: HTTP 404`);
  expect(logged).not.toContain("ghs_SECRET");
  expect(logged).not.toContain("PRIVATE KEY");
  closing.abort();
});

test("a push tells the open pages, read as the app, how the pull requests into the branch can be merged", async () => {
  const github = fakeGitHub();
  const head = "b".repeat(40);
  github.answers["/graphql"] = {
    data: {
      repository: {
        pullRequests: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [
            {
              number: 3,
              state: "OPEN",
              baseRefName: "main",
              headRefOid: head,
              mergeable: "CONFLICTING",
              mergeStateStatus: "DIRTY",
            },
          ],
        },
      },
    },
  };
  const closing = new AbortController();
  const app = createApp({
    staticRoot,
    webhookSecret: SECRET,
    githubApp,
    fetch: github.fetcher,
    closing: closing.signal,
  });
  await github.started();

  const stream = await app.request("/api/events");
  await post(app, "push", {
    ref: "refs/heads/main",
    after: "c".repeat(40),
    repository: { full_name: REPO },
    installation: { id: 1 },
  });
  await settle();
  const merge = (await events(stream, 4)).find((event) => event.name === "merge");
  expect(merge?.data).toEqual({ repo: REPO, base: "main", pulls: [{ number: 3, sha: head, mergeState: "conflicts" }] });
  closing.abort();
});
