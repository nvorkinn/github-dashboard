// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { Auth } from "./auth.ts";
import { sendQuery, withCost } from "./github/api.ts";
import { CHANGE_WAIT_MS, createDashboard, differences } from "./github/dashboard.ts";
import { account, fakeGitHub, fakeStreams, withPull } from "./github/testing.ts";
import type { DashboardData } from "./model.ts";
import { labelled, record, recorded, startTelemetry } from "./telemetry.ts";

let stop: (() => void) | undefined;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
});
afterEach(() => {
  stop?.();
  stop = undefined;
  vi.useRealTimers();
});

/** Telemetry started with a fake relay; `sent` are the events of every batch it was sent. */
function started(status = 204) {
  const sent: Record<string, unknown>[] = [];
  const tabs: string[] = [];
  const posts = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { tab: string; events: Record<string, unknown>[] };
    tabs.push(body.tab);
    sent.push(...body.events);
    return new Response(null, { status });
  });
  stop = startTelemetry({ fetch: posts as typeof fetch, beacon: () => true, flushMs: 1000 });
  return { sent, tabs, posts };
}

async function settle(): Promise<void> {
  for (let round = 0; round < 50; round++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

test("records nothing until started, then sends batches with the tab's id", async () => {
  record("stream", { live: true });
  const { sent, tabs, posts } = started();
  record("stream", { live: false, left: undefined });
  await vi.advanceTimersByTimeAsync(1000);
  expect(sent.map((event) => event.kind)).toEqual(["load", "stream"]);
  expect(sent[1]).toEqual({ kind: "stream", ts: expect.any(String), live: false });
  expect(tabs[0]).toMatch(/^[a-z0-9]+$/);

  // Nothing new, nothing sent.
  await vi.advanceTimersByTimeAsync(1000);
  expect(posts).toHaveBeenCalledTimes(1);
});

test("a relay that answers 404 stops the page sending", async () => {
  const { posts } = started(404);
  await vi.advanceTimersByTimeAsync(1000);
  record("stream", { live: true });
  await vi.advanceTimersByTimeAsync(5000);
  expect(posts).toHaveBeenCalledTimes(1);
});

test("a request is recorded with its purpose, its path without the query, and whether its answer changed", async () => {
  const { sent } = started();
  const auth = {
    github: (path: string, init?: RequestInit) =>
      recorded(path, init, async () =>
        Response.json([], {
          headers: { etag: '"a"', "x-ratelimit-resource": "core", "x-ratelimit-remaining": "4999" },
        }),
      ),
  } as Auth;
  const reading = labelled(auth, "review");
  await reading.github("repos/o/n/pulls/1/reviews?per_page=100");
  await reading.github("repos/o/n/pulls/1/reviews?per_page=100");
  await auth.github("user");
  await vi.advanceTimersByTimeAsync(1000);
  const requests = sent.filter((event) => event.kind === "request");
  expect(requests).toEqual([
    expect.objectContaining({
      method: "GET",
      path: "/repos/o/n/pulls/1/reviews",
      purpose: "review",
      status: 200,
      rateResource: "core",
      rateRemaining: 4999,
      unchanged: false,
    }),
    expect.objectContaining({ purpose: "review", unchanged: true }),
    expect.not.objectContaining({ purpose: expect.anything() }),
  ]);
});

test("a next page's whole address is recorded as its path", async () => {
  const { sent } = started();
  const auth = {
    github: (path: string, init?: RequestInit) => recorded(path, init, async () => Response.json([])),
  } as Auth;
  await auth.github("https://api.github.com/repositories/12/releases?per_page=100&page=2");
  await vi.advanceTimersByTimeAsync(1000);
  expect(sent.find((event) => event.kind === "request")).toEqual(
    expect.objectContaining({ path: "/repositories/12/releases" }),
  );
});

test("a GraphQL query asks its cost while recording, which is recorded and left out of the answer", async () => {
  const asked: string[] = [];
  const auth = {
    github: (path: string, init?: RequestInit) =>
      recorded(path, init, async () => {
        asked.push(JSON.parse(String(init?.body)).query);
        return Response.json({ data: { rateLimit: { cost: 3 }, viewer: { login: "me" } } });
      }),
  } as Auth;
  // Not recording: the query goes as it is.
  expect((await sendQuery(auth, "query { viewer { login } }", undefined)).data).toEqual({ viewer: { login: "me" } });
  expect(asked[0]).toBe("query { viewer { login } }");

  const { sent } = started();
  const answer = await sendQuery(labelled(auth, "read.changes"), "query { viewer { login } }", undefined);
  expect(answer.data).toEqual({ viewer: { login: "me" } });
  expect(asked[1]).toBe("query {\n  rateLimit { cost } viewer { login } }");
  await vi.advanceTimersByTimeAsync(1000);
  expect(sent.find((event) => event.kind === "request")).toEqual(
    expect.objectContaining({ path: "/graphql", purpose: "read.changes", cost: 3 }),
  );
});

test("only a query is asked its cost, as a mutation can't be", () => {
  expect(withCost("query($a: Int) {\n  x\n}\nfragment F on T { y }")).toBe(
    "query($a: Int) {\n  rateLimit { cost }\n  x\n}\nfragment F on T { y }",
  );
  expect(withCost("mutation { x }")).toBe("mutation { x }");
});

test("differences counts what a read found that the page didn't show", () => {
  const pull = (number: number, title: string) =>
    ({ repo: "o/n", number, title }) as unknown as DashboardData["pulls"][0];
  const before = { projects: [], pulls: [pull(1, "a"), pull(2, "b")], releases: [] } as unknown as DashboardData;
  const after = { projects: [], pulls: [pull(1, "a"), pull(3, "c")], releases: [] } as unknown as DashboardData;
  expect(differences(before, after)).toEqual({ projectsChanged: 0, pullsAdded: 1, pullsRemoved: 1, pullsChanged: 0 });
  expect(differences(after, after)).toEqual({ projectsChanged: 0, pullsAdded: 0, pullsRemoved: 0, pullsChanged: 0 });
});

test("each read is recorded with why it ran, and a webhook's change with how long it took to show", async () => {
  const { sent } = started();
  const routes = account("octo/app");
  withPull(routes, "octo/app", 1);
  const relay = fakeStreams();
  const dashboard = createDashboard(fakeGitHub(routes).auth, { connect: relay.connect });
  dashboard.start();
  await settle();
  relay.last().emit("hello");
  relay.last().change({ kind: "pull_request", repo: "octo/app", pull: 1, delivery: "d-1" });
  await vi.advanceTimersByTimeAsync(CHANGE_WAIT_MS);
  await settle();
  await vi.advanceTimersByTimeAsync(1000);
  dashboard.stop();

  const reads = sent.filter((event) => event.kind === "read");
  expect(reads[0]).toEqual(
    expect.objectContaining({ reason: "start", all: true, pullsAdded: 1, sinceLoadMs: expect.any(Number) }),
  );
  expect(reads.at(-1)).toEqual(expect.objectContaining({ reason: "event", all: false, repos: 1, pullsChanged: 0 }));
  expect(sent.filter((event) => event.kind === "change_shown")).toEqual([
    expect.objectContaining({ delivery: "d-1", change: "pull_request", waitedMs: CHANGE_WAIT_MS }),
  ]);
});
