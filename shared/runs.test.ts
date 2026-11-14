import { expect, test } from "vitest";
import { checkState, releaseTag, runState, settledJobs, shownRuns, job as toJob } from "./runs.ts";

test.each([
  ["queued", null, "queued"],
  ["requested", null, "queued"],
  ["pending", null, "queued"],
  ["in_progress", null, "running"],
  ["waiting", null, "waiting"],
  ["completed", "success", "passed"],
  ["completed", "failure", "failed"],
  ["completed", "timed_out", "failed"],
  ["completed", "startup_failure", "failed"],
  ["completed", "action_required", "failed"],
  ["completed", "stale", "failed"],
  ["completed", "cancelled", "cancelled"],
  ["completed", "skipped", "skipped"],
  ["completed", "neutral", "neutral"],
])("a check, run or job that is %s with conclusion %s is %s", (status, conclusion, state) => {
  expect(checkState(status, conclusion)).toBe(state);
});

test("of a workflow's runs, the unfinished ones and the latest finished one are shown", () => {
  const runs = [
    { id: 5, status: "queued" },
    { id: 4, status: "completed" },
    { id: 3, status: "in_progress" },
    { id: 2, status: "completed" },
  ];
  expect(shownRuns(runs).map((run) => run.id)).toEqual([5, 3, 4]);
  expect(shownRuns([])).toEqual([]);
});

/** A job as GitHub gives it. */
function job(id: number, more: { status: string; conclusion: string | null }) {
  return { id, name: `job ${id}`, html_url: null, started_at: null, completed_at: null, ...more };
}

test("a job GitHub calls waiting is waiting only with something to approve, or when that couldn't be read", () => {
  const jobs = [
    toJob(job(1, { status: "waiting", conclusion: null })),
    toJob(job(2, { status: "in_progress", conclusion: null })),
  ];
  const states = (approvals: Parameters<typeof settledJobs>[1]) => settledJobs(jobs, approvals).map((one) => one.state);
  expect(states([])).toEqual(["queued", "running"]);
  expect(states([{ environmentId: 7, environment: "production", canApprove: false }])).toEqual(["waiting", "running"]);
  expect(states(undefined)).toEqual(["waiting", "running"]);

  // The run goes by its jobs, whatever GitHub calls it.
  const waiting = { status: "waiting", conclusion: null };
  expect(runState(waiting, settledJobs(jobs, undefined))).toBe("waiting");
  expect(runState(waiting, settledJobs(jobs, []))).toBe("running");
  expect(runState(waiting, settledJobs(jobs.slice(0, 1), []))).toBe("queued");
  expect(runState(waiting, [])).toBe("queued");
  expect(runState({ status: "in_progress", conclusion: null }, settledJobs(jobs, undefined))).toBe("waiting");
  expect(runState({ status: "completed", conclusion: "success" }, jobs)).toBe("passed");
});

test("a release run's tag is the tag it ran on, or the version its own title names", () => {
  // Started by pushing a tag, or by publishing a release: the title is the commit's subject.
  expect(releaseTag({ event: "push", head_branch: "v1.2.3", display_title: "Fix the thing (#7)" })).toBe("v1.2.3");
  expect(releaseTag({ event: "release", head_branch: "2.0.0-rc.1", display_title: "Release" })).toBe("2.0.0-rc.1");
  // Started by hand from main, with a run-name.
  expect(releaseTag({ event: "workflow_dispatch", head_branch: "main", display_title: "Promote v1.12.3" })).toBe(
    "v1.12.3",
  );
  expect(
    releaseTag({ event: "workflow_dispatch", head_branch: "main", display_title: "Deploy 3.0.0-rc.3 to dev" }),
  ).toBe("3.0.0-rc.3");
  // A run that makes its tag as it goes doesn't say which.
  expect(releaseTag({ event: "workflow_dispatch", head_branch: "main", display_title: "Release" })).toBeUndefined();
  // A pushed commit's subject can name any version.
  expect(
    releaseTag({ event: "push", head_branch: "main", display_title: "Bump vite from 8.3.6 to 8.3.7" }),
  ).toBeUndefined();
  expect(releaseTag({ event: "workflow_dispatch", head_branch: "main", display_title: "Nightly 2026.11.11" })).toBe(
    "2026.11.11",
  );
  expect(releaseTag({ event: "schedule", head_branch: "main" })).toBeUndefined();
});
