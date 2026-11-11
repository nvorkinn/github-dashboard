// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { DashboardState } from "../model.ts";
import { createDashboard, describe, REFRESH_MS } from "./dashboard.ts";
import { account, fakeGitHub, type Routes, withPull } from "./testing.ts";

const NOW = new Date(2026, 10, 11, 14, 0, 0).getTime();
const FIRST = "user/installations?per_page=100";

let isHidden = false;

beforeEach(() => {
  // setImmediate stays real: the fake GitHub answers with it, and `settle` waits with it.
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"], now: NOW });
  isHidden = false;
  Object.defineProperty(document, "hidden", { configurable: true, get: () => isHidden });
});
afterEach(() => {
  vi.useRealTimers();
});

/** Lets the reads under way finish, without moving the clock. */
async function settle(): Promise<void> {
  for (let round = 0; round < 50; round++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function show(visible: boolean): void {
  isHidden = !visible;
  document.dispatchEvent(new Event("visibilitychange"));
}

function setUp(routes: Routes) {
  const github = fakeGitHub(routes);
  const dashboard = createDashboard(github.auth);
  const states: DashboardState[] = [];
  dashboard.subscribe(() => states.push(dashboard.state()));
  return { ...github, dashboard, states, reads: () => github.calls.filter((call) => call === FIRST).length };
}

function failing(status: number, headers: Record<string, string> = {}): () => Response {
  return () => Response.json({ message: "no" }, { status, headers });
}

test("loading, then ready with what was read", async () => {
  const routes = account("octo/app");
  withPull(routes, "octo/app", 1);
  const { dashboard, states } = setUp(routes);
  expect(dashboard.state()).toEqual({ status: "loading" });

  dashboard.start();
  expect(dashboard.state()).toEqual({ status: "loading" });
  await settle();
  expect(states).toHaveLength(1);
  expect(dashboard.state()).toMatchObject({ status: "ready", readAt: NOW, refreshing: false, problem: undefined });
  expect(dashboard.state()).toMatchObject({
    data: { projects: [{ repo: "octo/app" }], pulls: [{ number: 1 }], releases: [] },
  });
  dashboard.stop();
});

test("a first read that fails is failed, with words for the user, and the next one can make it ready", async () => {
  const routes = account("octo/app");
  const installations = routes["user/installations"];
  routes["user/installations"] = failing(502);
  const { dashboard } = setUp(routes);
  dashboard.start();
  await settle();
  expect(dashboard.state()).toEqual({ status: "failed", problem: "GitHub is having trouble (502)." });

  routes["user/installations"] = installations;
  await dashboard.refresh();
  expect(dashboard.state()).toMatchObject({ status: "ready", problem: undefined });
  dashboard.stop();
});

test("a later read is refreshing while under way, and keeps the old data with a problem if it fails", async () => {
  const routes = account("octo/app");
  const { dashboard, states } = setUp(routes);
  dashboard.start();
  await settle();
  const data = (dashboard.state() as { data: unknown }).data;

  routes["user/installations"] = failing(500);
  states.length = 0;
  vi.setSystemTime(NOW + 5000);
  await dashboard.refresh();
  expect(states).toEqual([
    { status: "ready", data, readAt: NOW, refreshing: true, problem: undefined },
    { status: "ready", data, readAt: NOW, refreshing: false, problem: "GitHub is having trouble (500)." },
  ]);
  dashboard.stop();
});

test("a project that can't be read is a problem beside the rest", async () => {
  const routes = account("octo/app", "octo/broken");
  routes["repos/octo/broken/pulls"] = failing(500);
  const { dashboard } = setUp(routes);
  dashboard.start();
  await settle();
  expect(dashboard.state()).toMatchObject({
    status: "ready",
    data: { projects: [{ repo: "octo/app" }, { repo: "octo/broken" }] },
    problem: "Couldn't read everything from octo/broken.",
  });
  dashboard.stop();
});

test("a rate limit says when it ends, and nothing is read before then", async () => {
  const routes = account("octo/app");
  const installations = routes["user/installations"];
  const reset = NOW + 32 * 60_000;
  routes["user/installations"] = failing(403, {
    "x-ratelimit-remaining": "0",
    "x-ratelimit-reset": String(reset / 1000),
  });
  const { dashboard, reads } = setUp(routes);
  dashboard.start();
  await settle();
  expect(dashboard.state()).toEqual({
    status: "failed",
    problem: "GitHub's rate limit is used up. Trying again at 14:32.",
  });

  routes["user/installations"] = installations;
  await vi.advanceTimersByTimeAsync(31 * 60_000);
  show(false);
  show(true);
  await settle();
  expect(reads()).toBe(1);

  await vi.advanceTimersByTimeAsync(60_000);
  await settle();
  expect(reads()).toBe(2);
  expect(dashboard.state()).toMatchObject({ status: "ready" });
  dashboard.stop();
});

test.each([
  [new TypeError("Failed to fetch"), "GitHub couldn't be reached."],
  [Object.assign(new Error("x"), { status: 401 }), "GitHub couldn't be reached."],
])("an error that isn't GitHub's answer reads as unreachable", (error, problem) => {
  expect(describe(error)).toBe(problem);
});

test("a sign-in GitHub no longer accepts says to sign in again", async () => {
  const routes = account("octo/app");
  routes["user/installations"] = failing(401);
  const { dashboard } = setUp(routes);
  dashboard.start();
  await settle();
  expect(dashboard.state()).toEqual({
    status: "failed",
    problem: "GitHub no longer accepts the sign-in. Sign in again.",
  });
  dashboard.stop();
});

test("reads again every minute, counted from the end of the last read", async () => {
  const { dashboard, reads } = setUp(account("octo/app"));
  dashboard.start();
  dashboard.start();
  await settle();
  expect(reads()).toBe(1);

  await vi.advanceTimersByTimeAsync(REFRESH_MS - 1);
  await settle();
  expect(reads()).toBe(1);
  await vi.advanceTimersByTimeAsync(1);
  await settle();
  expect(reads()).toBe(2);
  await vi.advanceTimersByTimeAsync(REFRESH_MS);
  await settle();
  expect(reads()).toBe(3);
  dashboard.stop();
});

test("refresh shares a read that is under way", async () => {
  const { dashboard, reads } = setUp(account("octo/app"));
  dashboard.start();
  await Promise.all([dashboard.refresh(), dashboard.refresh()]);
  expect(reads()).toBe(1);
  expect(dashboard.state()).toMatchObject({ status: "ready" });

  await dashboard.refresh();
  expect(reads()).toBe(2);
  dashboard.stop();
});

test("a hidden page doesn't read, and reads at once when it is shown again", async () => {
  const { dashboard, reads } = setUp(account("octo/app"));
  dashboard.start();
  await settle();

  show(false);
  await vi.advanceTimersByTimeAsync(10 * REFRESH_MS);
  await settle();
  expect(reads()).toBe(1);

  show(true);
  await vi.advanceTimersByTimeAsync(0);
  await settle();
  expect(reads()).toBe(2);
  await vi.advanceTimersByTimeAsync(REFRESH_MS);
  await settle();
  expect(reads()).toBe(3);
  dashboard.stop();
});

test("a read that ends while the page is hidden is kept, and no other follows until it is shown", async () => {
  const { dashboard, reads } = setUp(account("octo/app"));
  dashboard.start();
  show(false);
  await settle();
  expect(dashboard.state()).toMatchObject({ status: "ready" });
  await vi.advanceTimersByTimeAsync(10 * REFRESH_MS);
  await settle();
  expect(reads()).toBe(1);
  dashboard.stop();
});

test("stop goes back to loading, reads no more and drops a read that arrives late", async () => {
  const routes = account("octo/app");
  const { dashboard, states, reads, calls } = setUp(routes);
  dashboard.start();
  dashboard.stop();
  const asked = calls.length;
  await settle();
  // The requests already sent are answered, but nothing follows them and nothing is shown.
  expect(calls).toHaveLength(asked);
  expect(states).toEqual([]);
  expect(dashboard.state()).toEqual({ status: "loading" });

  dashboard.start();
  await settle();
  expect(dashboard.state()).toMatchObject({ status: "ready" });
  dashboard.stop();
  expect(dashboard.state()).toEqual({ status: "loading" });

  const before = reads();
  await dashboard.refresh();
  show(false);
  show(true);
  await vi.advanceTimersByTimeAsync(10 * REFRESH_MS);
  await settle();
  expect(reads()).toBe(before);
  expect(dashboard.state()).toEqual({ status: "loading" });
});

test("a read stopped midway doesn't replace what a new start reads", async () => {
  const routes = account("octo/app");
  // The fake doesn't end a request when asked to, like a response already on its way.
  let release: (() => void) | undefined;
  const repositories = routes["user/installations/7/repositories"];
  routes["user/installations/7/repositories"] = async () => {
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return Response.json({ total_count: 0, repositories: [] });
  };
  const { dashboard } = setUp(routes);
  dashboard.start();
  await settle();
  dashboard.stop();

  routes["user/installations/7/repositories"] = repositories;
  dashboard.start();
  await settle();
  release?.();
  await settle();
  expect(dashboard.state()).toMatchObject({ status: "ready", data: { projects: [{ repo: "octo/app" }] } });
  dashboard.stop();
});
