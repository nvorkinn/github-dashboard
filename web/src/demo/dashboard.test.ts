import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { CheckState, DashboardData } from "../model.ts";
import { summarize } from "../model.ts";
import { ACTION_MS, createDemoDashboard, demoPullActions, MERGED_MS, UPDATE_CHECKS_MS } from "./dashboard.ts";
import { FRAMES } from "./data.ts";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-03-01T12:00:00Z"));
});
afterEach(() => {
  vi.useRealTimers();
});

/** A started demo, past its moment of loading. */
function started(show?: string) {
  const dashboard = createDemoDashboard({ stepMs: 1000, show });
  dashboard.start();
  vi.advanceTimersByTime(400);
  return dashboard;
}

function data(dashboard: ReturnType<typeof createDemoDashboard>): DashboardData {
  const state = dashboard.state();
  if (state.status !== "ready") {
    throw new Error(`The demo is ${state.status}`);
  }
  return state.data;
}

const scriptedPull = (all: DashboardData) => all.pulls.find((pull) => pull.number === 128);
const scriptedRun = (all: DashboardData) => all.releases.find((run) => run.id === 9071);

test("loads for a moment, then has the sample data", () => {
  const dashboard = createDemoDashboard();
  expect(dashboard.state().status).toBe("loading");
  dashboard.start();
  expect(dashboard.state().status).toBe("loading");
  vi.advanceTimersByTime(400);
  expect(dashboard.state()).toMatchObject({ status: "ready", refreshing: false, problem: undefined, live: true });
  dashboard.stop();
});

test("has one of every case", () => {
  const dashboard = started();
  const { projects, pulls, releases } = data(dashboard);
  dashboard.stop();

  expect(projects.length).toBeGreaterThanOrEqual(5);
  expect(projects.some((project) => project.private)).toBe(true);
  expect(projects.some((project) => !project.latestRelease)).toBe(true);

  expect(pulls.length).toBeGreaterThanOrEqual(8);
  expect(new Set(pulls.map((pull) => pull.mergeState))).toEqual(
    new Set(["clean", "blocked", "conflicts", "behind", "unknown"]),
  );
  expect(new Set(pulls.map((pull) => summarize(pull.checks)))).toEqual(
    new Set(["none", "failed", "waiting", "running", "passed"]),
  );
  expect(pulls.some((pull) => pull.draft)).toBe(true);
  expect(pulls.some((pull) => pull.autoMerge)).toBe(true);
  expect(pulls.some((pull) => pull.author === "dependabot[bot]")).toBe(true);
  expect(pulls.some((pull) => pull.title.length > 100)).toBe(true);
  expect(pulls.some((pull) => pull.checks.length > 10)).toBe(true);
  // Every project a pull request or run names is one of the projects.
  const repos = new Set(projects.map((project) => project.repo));
  expect([...pulls, ...releases].every((one) => repos.has(one.repo))).toBe(true);

  const every: CheckState[] = ["queued", "running", "waiting", "passed", "failed", "cancelled", "skipped"];
  const jobStates = new Set(releases.flatMap((run) => run.jobs.map((job) => job.state)));
  expect(every.every((state) => jobStates.has(state))).toBe(true);
  expect(new Set(releases.map((run) => run.state))).toEqual(new Set(["running", "passed", "failed"]));
  // The demo fetches nothing: every avatar is drawn into its address.
  expect(pulls.every((pull) => pull.authorAvatarUrl?.startsWith("data:image/svg+xml,"))).toBe(true);
});

test("dates the data from now", () => {
  const dashboard = started();
  const { pulls } = data(dashboard);
  dashboard.stop();
  for (const pull of pulls) {
    expect(Date.parse(pull.createdAt)).toBeLessThanOrEqual(Date.now());
    expect(Date.parse(pull.updatedAt)).toBeGreaterThanOrEqual(Date.parse(pull.createdAt));
  }
});

test("the script moves the checks and the release along, finishes them and starts over", () => {
  const dashboard = started();
  const listener = vi.fn();
  dashboard.subscribe(listener);
  const first = data(dashboard);
  expect(summarize(scriptedPull(first)?.checks ?? [])).toBe("running");
  expect(scriptedRun(first)?.jobs.some((job) => job.state === "waiting")).toBe(true);

  const seen = new Set<string>();
  let finished = false;
  for (let step = 1; step < FRAMES; step++) {
    vi.advanceTimersByTime(1000);
    expect(listener).toHaveBeenCalledTimes(step);
    const now = data(dashboard);
    const run = scriptedRun(now);
    seen.add(run?.state ?? "");
    if (run?.state === "passed") {
      finished = true;
      expect(run.finishedAt).toBeDefined();
      expect(run.jobs.every((job) => job.state === "passed" || job.state === "skipped")).toBe(true);
      expect(scriptedPull(now)).toMatchObject({ mergeState: "clean" });
      expect(summarize(scriptedPull(now)?.checks ?? [])).toBe("passed");
    }
  }
  expect(finished).toBe(true);
  expect(seen).toEqual(new Set(["running", "waiting", "passed"]));

  // One more round of the loop is back where it began.
  vi.advanceTimersByTime(1000);
  expect(scriptedRun(data(dashboard))?.jobs.map((job) => job.state)).toEqual(
    scriptedRun(first)?.jobs.map((job) => job.state),
  );
  dashboard.stop();
});

test("a refresh shows for a moment", async () => {
  const dashboard = started();
  const before = dashboard.state();
  vi.advanceTimersByTime(300);
  const done = dashboard.refresh();
  expect(dashboard.state()).toMatchObject({ status: "ready", refreshing: true });
  vi.advanceTimersByTime(700);
  await done;
  const after = dashboard.state();
  expect(after).toMatchObject({ status: "ready", refreshing: false });
  expect(after.status === "ready" && before.status === "ready" && after.readAt > before.readAt).toBe(true);
  dashboard.stop();
});

test("stopping forgets the data and cancels every timer", () => {
  const dashboard = started();
  void dashboard.refresh();
  dashboard.stop();
  expect(dashboard.state()).toEqual({ status: "loading" });
  expect(vi.getTimerCount()).toBe(0);

  const listener = vi.fn();
  dashboard.subscribe(listener);
  vi.advanceTimersByTime(60_000);
  expect(listener).not.toHaveBeenCalled();
});

test("stopping during the first load cancels it, and it can start again", () => {
  const dashboard = createDemoDashboard({ stepMs: 1000 });
  dashboard.start();
  dashboard.stop();
  expect(vi.getTimerCount()).toBe(0);
  vi.advanceTimersByTime(5000);
  expect(dashboard.state().status).toBe("loading");

  dashboard.start();
  vi.advanceTimersByTime(400);
  expect(dashboard.state().status).toBe("ready");
  dashboard.stop();
});

test("starting twice runs one script", () => {
  const dashboard = started();
  dashboard.start();
  const listener = vi.fn();
  dashboard.subscribe(listener);
  vi.advanceTimersByTime(1000);
  expect(listener).toHaveBeenCalledOnce();
  dashboard.stop();
});

/** The demo's actions on a started demo, and the sample pull request numbered `number`, as it shows now. */
function withActions(show?: string) {
  const dashboard = started(show);
  const actions = demoPullActions(dashboard);
  if (!actions) {
    throw new Error("The demo has no actions");
  }
  const find = (number: number) => data(dashboard).pulls.find((pull) => pull.number === number);
  const get = (number: number) => {
    const found = find(number);
    if (!found) {
      throw new Error(`#${number} isn't shown`);
    }
    return found;
  };
  return { dashboard, actions, find, get };
}

test("only the demo's own dashboard has the demo's actions", () => {
  expect(demoPullActions(createDemoDashboard())).toBeDefined();
  expect(demoPullActions({ ...createDemoDashboard() })).toBeUndefined();
});

test("the sample data has a pull request for each action, and one where auto-merge is refused", () => {
  const dashboard = started();
  const { projects, pulls } = data(dashboard);
  dashboard.stop();
  expect(pulls.some((pull) => pull.mergeState === "clean" && !pull.draft && !pull.autoMerge)).toBe(true);
  expect(pulls.some((pull) => pull.mergeState === "behind" && !pull.draft)).toBe(true);
  expect(new Set(projects.map((project) => project.mergeMethod))).toEqual(new Set(["merge", "squash", "rebase"]));
  const refusing = projects.filter((project) => !project.autoMergeAllowed).map((project) => project.repo);
  expect(pulls.some((pull) => refusing.includes(pull.repo) && !pull.draft)).toBe(true);
  expect(new Set(pulls.map((pull) => pull.nodeId)).size).toBe(pulls.length);
});

test("turning auto-merge on and off takes a moment, and then shows, also as the script moves on", async () => {
  const { dashboard, actions, get } = withActions();
  const turning = actions.setAutoMerge(get(338), true);
  vi.advanceTimersByTime(ACTION_MS - 1);
  expect(get(338).autoMerge).toBe(false);
  vi.advanceTimersByTime(1);
  await expect(turning).resolves.toEqual({ merged: false });
  expect(get(338).autoMerge).toBe(true);
  vi.advanceTimersByTime(3000);
  expect(get(338).autoMerge).toBe(true);

  const off = actions.setAutoMerge(get(128), false);
  vi.advanceTimersByTime(ACTION_MS);
  await off;
  expect(get(128).autoMerge).toBe(false);
  dashboard.stop();
});

test("auto-merge is refused where the repository doesn't allow it, and for a draft", async () => {
  const { dashboard, actions, get } = withActions();
  const refused = actions.setAutoMerge(get(9), true);
  vi.advanceTimersByTime(ACTION_MS);
  await expect(refused).rejects.toThrow("Auto-merge is off for this repository");
  expect(get(9).autoMerge).toBe(false);

  const draft = actions.setAutoMerge(get(212), true);
  vi.advanceTimersByTime(ACTION_MS);
  await expect(draft).rejects.toThrow("ready for review");
  dashboard.stop();
});

test("a merged pull request leaves the list a moment later", async () => {
  const { dashboard, actions, get, find } = withActions();
  const merging = actions.merge(get(131));
  vi.advanceTimersByTime(ACTION_MS);
  await merging;
  expect(find(131)).toBeDefined();
  vi.advanceTimersByTime(MERGED_MS);
  expect(find(131)).toBeUndefined();
  vi.advanceTimersByTime(10_000);
  expect(find(131)).toBeUndefined();
  dashboard.stop();
});

test("an updated branch runs its checks again, and is then ready to merge", async () => {
  const { dashboard, actions, get } = withActions("offline");
  const before = get(61);
  expect(before.mergeState).toBe("behind");
  const updating = actions.updateBranch(before);
  vi.advanceTimersByTime(ACTION_MS);
  await updating;
  const after = get(61);
  expect(after.mergeState).toBe("blocked");
  expect(after.sha).not.toBe(before.sha);
  expect(summarize(after.checks)).toBe("running");
  vi.advanceTimersByTime(UPDATE_CHECKS_MS);
  expect(get(61).mergeState).toBe("clean");
  expect(summarize(get(61).checks)).toBe("passed");
  dashboard.stop();
});

test("stopping forgets what the actions did", async () => {
  const { dashboard, actions, get, find } = withActions();
  const merging = actions.merge(get(131));
  vi.advanceTimersByTime(ACTION_MS);
  await merging;
  vi.advanceTimersByTime(MERGED_MS);
  dashboard.stop();
  dashboard.start();
  vi.advanceTimersByTime(400);
  expect(find(131)).toBeDefined();
  dashboard.stop();
});

test("can hold a state the script never reaches", () => {
  const loading = started("loading");
  vi.advanceTimersByTime(60_000);
  expect(loading.state().status).toBe("loading");

  expect(started("failed").state()).toMatchObject({ status: "failed" });

  const empty = started("empty");
  expect(data(empty)).toEqual({ projects: [], pulls: [], releases: [] });

  const problem = started("problem");
  expect(problem.state()).toMatchObject({ status: "ready", problem: expect.stringContaining("GitHub"), live: true });
  expect(data(problem).pulls.length).toBeGreaterThan(0);

  const offline = started("offline");
  expect(offline.state()).toMatchObject({ status: "ready", problem: undefined, live: false });
  expect(data(offline).pulls.length).toBeGreaterThan(0);
  // None of them runs the script.
  expect(vi.getTimerCount()).toBe(0);
});
