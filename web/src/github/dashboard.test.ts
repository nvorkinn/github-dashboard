// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { DashboardState } from "../model.ts";
import {
  CHANGE_MAX_WAIT_MS,
  CHANGE_WAIT_MS,
  createDashboard,
  describe,
  LIVE_REFRESH_MS,
  REFRESH_MS,
  SETTLE_MS,
  SETTLE_TRIES,
} from "./dashboard.ts";
import { account, fakeGitHub, fakeStreams, type Routes, withPull } from "./testing.ts";

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

/** A dashboard on a fake GitHub. With no relay to connect to, unless `relay` is given. */
function setUp(routes: Routes, relay?: ReturnType<typeof fakeStreams>) {
  const github = fakeGitHub(routes);
  const dashboard = createDashboard(github.auth, relay ? { connect: relay.connect } : {});
  const states: DashboardState[] = [];
  dashboard.subscribe(() => states.push(dashboard.state()));
  return { ...github, dashboard, states, reads: () => github.calls.filter((call) => call === FIRST).length };
}

/** A dashboard that has read everything and is connected to a fake relay, which has said hello. */
async function setUpLive(routes: Routes) {
  const relay = fakeStreams();
  const all = setUp(routes, relay);
  all.dashboard.start();
  await settle();
  relay.last().emit("hello");
  all.calls.length = 0;
  all.states.length = 0;
  return { ...all, relay, stream: relay.last() };
}

/** Moves the clock on, and lets the reads that starts finish. */
async function pass(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
  await settle();
}

const pullCalls = (number: number) => [
  `repos/octo/app/pulls/${number}`,
  `repos/octo/app/commits/sha${number}/check-runs?filter=latest&per_page=100`,
  `repos/octo/app/commits/sha${number}/statuses?per_page=100`,
];

/** An answer that waits to be let go, to have a read under way for as long as a test wants. */
function held(answer: unknown): { route: () => Promise<Response>; release: () => void } {
  let release = () => {};
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { route: () => waiting.then(() => Response.json(answer)), release: () => release() };
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
    { status: "ready", data, readAt: NOW, refreshing: true, problem: undefined, live: false },
    { status: "ready", data, readAt: NOW, refreshing: false, problem: "GitHub is having trouble (500).", live: false },
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

// From here on: the relay's events.

function appWithPulls(): Routes {
  const routes = account("octo/app");
  withPull(routes, "octo/app", 1);
  withPull(routes, "octo/app", 2);
  return routes;
}

test("is live from the relay's hello until the connection ends", async () => {
  const relay = fakeStreams();
  const { dashboard } = setUp(account("octo/app"), relay);
  dashboard.start();
  await settle();
  expect(relay.streams).toHaveLength(1);
  expect(dashboard.state()).toMatchObject({ status: "ready", live: false });

  relay.last().emit("hello");
  expect(dashboard.state()).toMatchObject({ status: "ready", live: true });
  relay.last().emit("error");
  expect(dashboard.state()).toMatchObject({ status: "ready", live: false });

  await pass(1000);
  expect(relay.streams).toHaveLength(2);
  relay.last().emit("hello");
  expect(dashboard.state()).toMatchObject({ status: "ready", live: true });
  dashboard.stop();
});

test("a hello during the first read or just after it doesn't read again", async () => {
  const relay = fakeStreams();
  const { dashboard, reads } = setUp(account("octo/app"), relay);
  dashboard.start();
  relay.last().emit("hello");
  await pass(0);
  expect(reads()).toBe(1);
  // The state is live although the hello came before there was any.
  expect(dashboard.state()).toMatchObject({ status: "ready", live: true });
  dashboard.stop();

  const later = await setUpLive(account("octo/app"));
  await pass(1000);
  expect(later.reads()).toBe(0);
  later.dashboard.stop();
});

test("a hello after reconnecting reads everything, as what happened meanwhile is lost", async () => {
  const { dashboard, relay, stream, reads } = await setUpLive(account("octo/app"));
  await pass(10_000);
  stream.emit("error");
  await pass(1000);
  expect(reads()).toBe(0);

  relay.last().emit("hello");
  await pass(0);
  expect(reads()).toBe(1);
  dashboard.stop();
});

test("a change is read a second after it came, and only what it names", async () => {
  const { dashboard, stream, calls, states } = await setUpLive(appWithPulls());
  stream.change({ kind: "check_run", repo: "octo/app", action: "completed", sha: "sha1" });
  await pass(CHANGE_WAIT_MS - 1);
  expect(calls).toEqual([]);
  await pass(1);
  expect(calls).toEqual(pullCalls(1));
  // The page gets the new data once, without a refresh showing in between.
  expect(states).toMatchObject([{ status: "ready", readAt: NOW + CHANGE_WAIT_MS, refreshing: false, live: true }]);

  await pass(60_000);
  expect(calls).toHaveLength(3);
  dashboard.stop();
});

test("a change the page made itself is read like one the relay sent, and not on a stopped page", async () => {
  const { dashboard, calls } = await setUpLive(appWithPulls());
  dashboard.changed({ kind: "pull_request", repo: "octo/app", pull: 1 });
  await pass(CHANGE_WAIT_MS);
  expect(calls).toEqual(pullCalls(1));

  dashboard.stop();
  calls.length = 0;
  dashboard.changed({ kind: "pull_request", repo: "octo/app", pull: 1 });
  await pass(60_000);
  expect(calls).toEqual([]);
});

test("a burst of changes is one read, a second after the last of them", async () => {
  const { dashboard, stream, calls } = await setUpLive(appWithPulls());
  stream.change({ kind: "check_run", repo: "octo/app", sha: "sha1" });
  await pass(600);
  stream.change({ kind: "check_run", repo: "octo/app", sha: "sha2" });
  await pass(600);
  stream.change({ kind: "status", repo: "octo/app", sha: "sha1" });
  await pass(CHANGE_WAIT_MS - 1);
  expect(calls).toEqual([]);
  await pass(1);
  expect([...calls].sort()).toEqual([...pullCalls(1), ...pullCalls(2)].sort());
  dashboard.stop();
});

test("changes that keep coming are read no later than five seconds after the first", async () => {
  const { dashboard, stream, calls } = await setUpLive(appWithPulls());
  for (let sent = 0; sent < 6; sent++) {
    stream.change({ kind: "check_run", repo: "octo/app", sha: "sha1" });
    await pass(800);
  }
  stream.change({ kind: "check_run", repo: "octo/app", sha: "sha1" });
  await pass(CHANGE_MAX_WAIT_MS - 6 * 800 - 1);
  expect(calls).toEqual([]);
  await pass(1);
  expect(calls).toEqual(pullCalls(1));

  // The next burst counts from its own first change.
  stream.change({ kind: "check_run", repo: "octo/app", sha: "sha1" });
  await pass(CHANGE_WAIT_MS - 1);
  expect(calls).toHaveLength(3);
  await pass(1);
  expect(calls).toHaveLength(6);
  dashboard.stop();
});

test("changes that arrive during a read of changes are read once more after it", async () => {
  const routes = appWithPulls();
  const { dashboard, stream, calls } = await setUpLive(routes);
  const answer = routes["repos/octo/app/pulls/1"];
  const hold = held(answer);
  routes["repos/octo/app/pulls/1"] = hold.route;
  stream.change({ kind: "check_run", repo: "octo/app", sha: "sha1" });
  await pass(CHANGE_WAIT_MS);
  expect(calls).toEqual(["repos/octo/app/pulls/1"]);

  routes["repos/octo/app/pulls/1"] = answer;
  stream.change({ kind: "check_run", repo: "octo/app", sha: "sha1" });
  stream.change({ kind: "check_run", repo: "octo/app", sha: "sha1" });
  await pass(CHANGE_MAX_WAIT_MS);
  expect(calls).toEqual(["repos/octo/app/pulls/1"]);

  hold.release();
  await settle();
  expect(calls).toEqual([...pullCalls(1), ...pullCalls(1)]);
  await pass(60_000);
  expect(calls).toHaveLength(6);
  dashboard.stop();
});

test("a change that arrives during a read of everything is read after it", async () => {
  const routes = appWithPulls();
  const relay = fakeStreams();
  const hold = held(routes["user/installations/7/repositories"]);
  routes["user/installations/7/repositories"] = hold.route;
  const { dashboard, calls, reads } = setUp(routes, relay);
  dashboard.start();
  await settle();
  relay.last().emit("hello");
  relay.last().change({ kind: "pull_request", repo: "octo/app", action: "synchronize", pull: 2 });
  await pass(CHANGE_WAIT_MS);
  expect(dashboard.state()).toEqual({ status: "loading" });

  hold.release();
  await settle();
  expect(reads()).toBe(1);
  expect(calls.slice(-3)).toEqual(pullCalls(2));
  expect(calls.filter((call) => call === "repos/octo/app/pulls/2")).toHaveLength(2);
  dashboard.stop();
});

test("a read of everything takes the changes that were waiting with it", async () => {
  const { dashboard, stream, calls, reads } = await setUpLive(appWithPulls());
  stream.change({ kind: "check_run", repo: "octo/app", sha: "sha1" });
  await pass(500);
  await dashboard.refresh();
  await pass(CHANGE_MAX_WAIT_MS);
  expect(reads()).toBe(1);
  expect(calls.filter((call) => call === "repos/octo/app/pulls/1")).toHaveLength(1);
  dashboard.stop();
});

test("a refresh during a read of changes reads everything after it", async () => {
  const routes = appWithPulls();
  const { dashboard, stream, calls, reads } = await setUpLive(routes);
  const hold = held(routes["repos/octo/app/pulls/1"]);
  routes["repos/octo/app/pulls/1"] = hold.route;
  stream.change({ kind: "check_run", repo: "octo/app", sha: "sha1" });
  await pass(CHANGE_WAIT_MS);

  const refreshed = dashboard.refresh();
  await settle();
  expect(reads()).toBe(0);
  hold.release();
  await refreshed;
  expect(reads()).toBe(1);
  expect(calls.slice(0, 3)).toEqual(pullCalls(1));
  expect(dashboard.state()).toMatchObject({ status: "ready", refreshing: false });
  dashboard.stop();
});

test.each([
  ["that changes which repositories there are", { kind: "repository", repo: "octo/app", action: "renamed" }],
  ["that names no repository", { kind: "installation_repositories", action: "added" }],
  ["in a repository that isn't known", { kind: "pull_request", repo: "octo/new", pull: 1 }],
])("a change %s reads everything", async (_, change) => {
  const { dashboard, stream, reads } = await setUpLive(appWithPulls());
  stream.change(change);
  await pass(CHANGE_WAIT_MS - 1);
  expect(reads()).toBe(0);
  await pass(1);
  expect(reads()).toBe(1);
  dashboard.stop();
});

test("a change of a kind that isn't known reads nothing", async () => {
  const { dashboard, stream, calls } = await setUpLive(appWithPulls());
  stream.change({ kind: "something_new", repo: "octo/app" });
  await pass(CHANGE_MAX_WAIT_MS);
  expect(calls).toEqual([]);
  dashboard.stop();
});

test("a change that shows nowhere on the page reads nothing and leaves the state alone", async () => {
  const { dashboard, stream, calls, states } = await setUpLive(appWithPulls());
  stream.change({ kind: "check_run", repo: "octo/app", sha: "a commit on main" });
  await pass(CHANGE_MAX_WAIT_MS);
  expect(calls).toEqual([]);
  expect(states).toEqual([]);
  dashboard.stop();
});

test("while live everything is read every five minutes, whatever changes are read in between", async () => {
  const { dashboard, stream, reads } = await setUpLive(appWithPulls());
  await pass(LIVE_REFRESH_MS - 60_000);
  stream.change({ kind: "check_run", repo: "octo/app", sha: "sha1" });
  await pass(CHANGE_WAIT_MS);
  expect(reads()).toBe(0);
  await pass(60_000 - CHANGE_WAIT_MS - 1);
  expect(reads()).toBe(0);
  await pass(1);
  expect(reads()).toBe(1);

  await pass(LIVE_REFRESH_MS - 1);
  expect(reads()).toBe(1);
  await pass(1);
  expect(reads()).toBe(2);
  dashboard.stop();
});

test("once the connection is lost everything is read every minute again, until the next hello", async () => {
  const { dashboard, relay, stream, reads } = await setUpLive(account("octo/app"));
  await pass(30_000);
  stream.emit("error");
  await pass(REFRESH_MS - 1);
  expect(reads()).toBe(0);
  await pass(1);
  expect(reads()).toBe(1);
  await pass(REFRESH_MS);
  expect(reads()).toBe(2);

  await pass(10_000);
  relay.last().emit("hello");
  await pass(0);
  expect(reads()).toBe(3);
  await pass(LIVE_REFRESH_MS - 1);
  expect(reads()).toBe(3);
  await pass(1);
  expect(reads()).toBe(4);
  dashboard.stop();
});

test("a read that failed is tried again in a minute also while live, and a change before that reads everything", async () => {
  const routes = appWithPulls();
  const { dashboard, stream, reads } = await setUpLive(routes);
  const installations = routes["user/installations"];
  routes["user/installations"] = failing(500);
  await dashboard.refresh();
  expect(reads()).toBe(1);
  expect(dashboard.state()).toMatchObject({ status: "ready", problem: "GitHub is having trouble (500)." });

  await pass(REFRESH_MS);
  expect(reads()).toBe(2);

  routes["user/installations"] = installations;
  stream.change({ kind: "check_run", repo: "octo/app", sha: "sha1" });
  await pass(CHANGE_WAIT_MS);
  expect(reads()).toBe(3);
  expect(dashboard.state()).toMatchObject({ status: "ready", problem: undefined });
  dashboard.stop();
});

test("a change doesn't read before a rate limit ends", async () => {
  const routes = appWithPulls();
  const { dashboard, stream, calls, reads } = await setUpLive(routes);
  const installations = routes["user/installations"];
  routes["user/installations"] = failing(429, { "retry-after": "600" });
  await dashboard.refresh();
  routes["user/installations"] = installations;
  calls.length = 0;

  stream.change({ kind: "check_run", repo: "octo/app", sha: "sha1" });
  await pass(CHANGE_MAX_WAIT_MS);
  stream.change({ kind: "repository", repo: "octo/app" });
  await pass(CHANGE_MAX_WAIT_MS);
  await pass(600_000 - 2 * CHANGE_MAX_WAIT_MS - 1);
  expect(calls).toEqual([]);

  await pass(1);
  expect(reads()).toBe(1);
  expect(dashboard.state()).toMatchObject({ status: "ready", problem: undefined });
  dashboard.stop();
});

test("a part that a read of changes couldn't read is a problem, and everything is read within a minute", async () => {
  const routes = appWithPulls();
  const { dashboard, stream, reads } = await setUpLive(routes);
  const answer = routes["repos/octo/app/pulls/1"];
  routes["repos/octo/app/pulls/1"] = failing(502);
  await pass(120_000);
  stream.change({ kind: "check_run", repo: "octo/app", sha: "sha1" });
  await pass(CHANGE_WAIT_MS);
  expect(dashboard.state()).toMatchObject({
    status: "ready",
    problem: "Couldn't read everything from octo/app.",
    data: { pulls: [{ number: 1 }, { number: 2 }] },
  });

  routes["repos/octo/app/pulls/1"] = answer;
  await pass(REFRESH_MS - 1);
  expect(reads()).toBe(0);
  await pass(1);
  expect(reads()).toBe(1);
  expect(dashboard.state()).toMatchObject({ status: "ready", problem: undefined });
  dashboard.stop();
});

test("what a read of everything couldn't read stays a problem after a read of changes elsewhere", async () => {
  const routes = account("octo/app", "octo/broken");
  withPull(routes, "octo/app", 1);
  routes["repos/octo/broken/pulls"] = failing(500);
  const { dashboard, stream, calls } = await setUpLive(routes);
  stream.change({ kind: "check_run", repo: "octo/app", sha: "sha1" });
  await pass(CHANGE_WAIT_MS);
  expect(calls).toEqual(pullCalls(1));
  expect(dashboard.state()).toMatchObject({
    status: "ready",
    readAt: NOW + CHANGE_WAIT_MS,
    problem: "Couldn't read everything from octo/broken.",
  });
  dashboard.stop();
});

test("a hidden page drops the connection and reads nothing; shown again it connects and reads everything once", async () => {
  const { dashboard, relay, stream, reads } = await setUpLive(appWithPulls());
  stream.change({ kind: "check_run", repo: "octo/app", sha: "sha1" });
  show(false);
  expect(stream.closed).toBe(true);
  expect(dashboard.state()).toMatchObject({ status: "ready", live: false });
  await pass(2 * LIVE_REFRESH_MS);
  expect(relay.streams).toHaveLength(1);
  expect(reads()).toBe(0);
  expect(vi.getTimerCount()).toBe(0);

  show(true);
  expect(relay.streams).toHaveLength(2);
  relay.last().emit("hello");
  await pass(0);
  expect(reads()).toBe(1);
  expect(dashboard.state()).toMatchObject({ status: "ready", live: true });
  await pass(LIVE_REFRESH_MS - 1);
  expect(reads()).toBe(1);
  dashboard.stop();
});

test("stop closes the connection and forgets the changes that were waiting", async () => {
  const { dashboard, relay, stream, calls } = await setUpLive(appWithPulls());
  stream.change({ kind: "check_run", repo: "octo/app", sha: "sha1" });
  dashboard.stop();
  expect(stream.closed).toBe(true);
  expect(vi.getTimerCount()).toBe(0);

  stream.emit("hello");
  stream.change({ kind: "repository" });
  await pass(2 * LIVE_REFRESH_MS);
  expect(relay.streams).toHaveLength(1);
  expect(calls).toEqual([]);
  expect(dashboard.state()).toEqual({ status: "loading" });

  // Started again, it connects again and is not live until the relay says so.
  dashboard.start();
  await settle();
  expect(relay.streams).toHaveLength(2);
  expect(dashboard.state()).toMatchObject({ status: "ready", live: false });
  dashboard.stop();
});

test("a pull request whose merge state GitHub hasn't worked out is asked about again, a few times", async () => {
  const routes = account("octo/app");
  withPull(routes, "octo/app", 1, { pull: { mergeable: null, mergeable_state: "unknown" } });
  withPull(routes, "octo/app", 2);
  const { dashboard, calls } = setUp(routes);
  dashboard.start();
  await settle();
  expect(dashboard.state()).toMatchObject({ data: { pulls: [{ mergeState: "unknown" }, { mergeState: "clean" }] } });
  calls.length = 0;

  await pass(SETTLE_MS + CHANGE_WAIT_MS - 1);
  expect(calls).toEqual([]);
  await pass(1);
  expect(calls).toEqual(pullCalls(1));

  // Still unknown: asked again, and then no more, so that one GitHub never works out isn't asked about for ever.
  for (let second = 0; second < 30; second++) {
    await pass(1000);
  }
  expect(calls).toHaveLength(3 * SETTLE_TRIES);
  dashboard.stop();
});

test("and no more once GitHub has", async () => {
  const routes = account("octo/app");
  withPull(routes, "octo/app", 1, { pull: { mergeable: null, mergeable_state: "unknown" } });
  const { dashboard, calls } = setUp(routes);
  dashboard.start();
  await settle();
  calls.length = 0;

  routes["repos/octo/app/pulls/1"] = { ...(routes["repos/octo/app/pulls/1"] as object), mergeable: true };
  routes["repos/octo/app/pulls/1"] = {
    ...(routes["repos/octo/app/pulls/1"] as object),
    mergeable_state: "clean",
  };
  for (let second = 0; second < 30; second++) {
    await pass(1000);
  }
  expect(calls).toEqual(pullCalls(1));
  expect(dashboard.state()).toMatchObject({ data: { pulls: [{ mergeState: "clean" }] } });
  dashboard.stop();
});
