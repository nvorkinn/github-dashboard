import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { Approval, CheckState, DashboardData, Job } from "../model.ts";
import { promoteTag, summarize } from "../model.ts";
import { ACTION_MS, FAILING_PROJECT } from "./actions.ts";
import { createDemoDashboard } from "./dashboard.ts";
import { FRAMES, SCRIPTED_RUN } from "./data.ts";

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
  expect(new Set(releases.map((run) => run.state))).toEqual(new Set(["running", "waiting", "passed", "failed"]));
  // Something for every action: an approval the user can give and one they can't, a run and a job to re-run, a
  // project to promote and one to release.
  const approvals = releases.flatMap((run) => run.approvals);
  expect(new Set(approvals.map((one) => one.canApprove))).toEqual(new Set([true, false]));
  expect(releases.some((run) => run.state === "failed" && run.jobs.some((job) => job.state === "cancelled"))).toBe(
    true,
  );
  expect(projects.filter((project) => promoteTag(project))).toHaveLength(1);
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

/** What an action of the demo comes to, once its moment has passed. */
async function acted<T>(doing: Promise<T>): Promise<T> {
  await vi.advanceTimersByTimeAsync(ACTION_MS);
  return doing;
}

const byId = (all: DashboardData, id: number) => {
  const found = all.releases.find((run) => run.id === id);
  if (!found) {
    throw new Error(`No run ${id}`);
  }
  return found;
};
const byName = (all: DashboardData, name: string) => {
  const found = all.projects.find((project) => project.name === name);
  if (!found) {
    throw new Error(`No project ${name}`);
  }
  return found;
};
const PROMOTE_RUN = 2781;
const FAILED_RUN = 4410;

test("approving the waiting run moves it on, and its button goes", async () => {
  // Held, so the script doesn't move anything else meanwhile.
  const dashboard = started("offline");
  const waiting = byId(data(dashboard), PROMOTE_RUN);
  expect(waiting).toMatchObject({ state: "waiting", approvals: [{ environment: "production", canApprove: true }] });
  const listener = vi.fn();
  dashboard.subscribe(listener);

  const approving = dashboard.runActions.review(waiting, waiting.approvals[0] as Approval, "approved");
  await vi.advanceTimersByTimeAsync(ACTION_MS - 1);
  expect(byId(data(dashboard), PROMOTE_RUN).state).toBe("waiting");
  await acted(approving);
  expect(listener).toHaveBeenCalled();
  const after = byId(data(dashboard), PROMOTE_RUN);
  expect(after.state).toBe("running");
  expect(after.approvals).toEqual([]);
  expect(after.jobs.map((job) => job.state)).toEqual(["passed", "passed", "running", "queued"]);
  dashboard.stop();
});

test("rejecting the waiting run fails it", async () => {
  const dashboard = started("offline");
  const waiting = byId(data(dashboard), PROMOTE_RUN);
  await acted(dashboard.runActions.review(waiting, waiting.approvals[0] as Approval, "rejected"));
  const after = byId(data(dashboard), PROMOTE_RUN);
  expect(after).toMatchObject({ state: "failed", approvals: [] });
  expect(after.finishedAt).toBeDefined();
  expect(after.jobs.map((job) => job.state)).toEqual(["passed", "failed", "skipped", "skipped"]);
  dashboard.stop();
});

test("re-running the failed run's jobs, or one of them, puts them back to queued", async () => {
  const dashboard = started("offline");
  const failed = byId(data(dashboard), FAILED_RUN);
  expect(failed.state).toBe("failed");
  await acted(dashboard.runActions.rerunFailed(failed));
  const after = byId(data(dashboard), FAILED_RUN);
  expect(after).toMatchObject({ state: "queued", finishedAt: undefined });
  expect(after.jobs.map((job) => job.state)).toEqual(["passed", "passed", "queued", "queued", "queued", "queued"]);
  dashboard.stop();

  const again = started("offline");
  const job = byId(data(again), FAILED_RUN).jobs.find((one) => one.state === "cancelled") as Job;
  await acted(again.runActions.rerunJob(byId(data(again), FAILED_RUN), job));
  expect(byId(data(again), FAILED_RUN).jobs.map((one) => one.state)).toEqual([
    "passed",
    "passed",
    "failed",
    "queued",
    "queued",
    "queued",
  ]);
  again.stop();
});

test("a release works out the next tag, then adds the release and a run of it", async () => {
  const dashboard = started("offline");
  const project = byName(data(dashboard), "weather-station");
  const tag = await acted(dashboard.runActions.nextRelease(project));
  expect(tag).toBe("v2.5.0");
  await acted(dashboard.runActions.release(project, tag));
  const after = data(dashboard);
  expect(byName(after, "weather-station").latestRelease?.tag).toBe("v2.5.0");
  expect(after.releases.at(-1)).toMatchObject({
    repo: project.repo,
    workflow: "Release",
    title: "v2.5.0",
    state: "running",
    finishedAt: undefined,
  });
  // A project without a release yet gets its first.
  expect(await acted(dashboard.runActions.nextRelease(byName(after, "recipe-box")))).toBe("v1.0.0");
  dashboard.stop();
});

test("promoting adds a run of the Promote workflow", async () => {
  const dashboard = started("offline");
  const project = byName(data(dashboard), "home-ledger");
  const tag = promoteTag(project) as string;
  expect(tag).toBe("v1.12.3");
  await acted(dashboard.runActions.promote(project, tag));
  expect(data(dashboard).releases.at(-1)).toMatchObject({ workflow: "Promote", title: tag, state: "running" });
  dashboard.stop();
});

test("one sample action fails, so the preview shows how that looks", async () => {
  const dashboard = started("offline");
  const failing = dashboard.runActions.nextRelease(byName(data(dashboard), FAILING_PROJECT));
  const outcome = expect(failing).rejects.toThrow("Tag v3.1.0 already exists. Resolve it on GitHub before releasing.");
  await vi.advanceTimersByTimeAsync(ACTION_MS);
  await outcome;
  dashboard.stop();
});

test("the scripted run waits for its approval again each time round, and stopping forgets every action", async () => {
  const dashboard = started();
  const scripted = byId(data(dashboard), SCRIPTED_RUN);
  // Its required reviewer is someone else: the script approves it.
  expect(scripted.approvals).toEqual([{ environmentId: 70, environment: "production", canApprove: false }]);
  await acted(dashboard.runActions.review(scripted, scripted.approvals[0] as Approval, "rejected"));
  expect(byId(data(dashboard), SCRIPTED_RUN).state).toBe("failed");
  // Round to the same frame again.
  await vi.advanceTimersByTimeAsync(FRAMES * 1000 - ACTION_MS);
  expect(byId(data(dashboard), SCRIPTED_RUN).approvals).toHaveLength(1);

  await acted(dashboard.runActions.rerunFailed(byId(data(dashboard), FAILED_RUN)));
  dashboard.stop();
  dashboard.start();
  vi.advanceTimersByTime(400);
  expect(byId(data(dashboard), FAILED_RUN).state).toBe("failed");
  dashboard.stop();
});
