/**
 * Release runs as plain data, and how GitHub's words for a run and its jobs become them. The relay and the page both
 * use this, so the two can't differ in what they make of a run. Nothing here knows about HTTP.
 *
 * Times are ISO strings as GitHub gives them. Addresses ending in `Url` open the thing on github.com.
 */
import { jobGraph, type WorkflowJob } from "./workflows.ts";

/** How one check, job or run stands. `waiting` is waiting for an approval, such as a protected environment. */
export type CheckState = "queued" | "running" | "waiting" | "passed" | "failed" | "cancelled" | "skipped" | "neutral";

/** One job of a workflow run. */
export type Job = {
  id: number;
  name: string;
  state: CheckState;
  url: string | undefined;
  startedAt: string | undefined;
  finishedAt: string | undefined;
};

/**
 * One run of a release workflow: one whose file carries the comment `# dashboard: release` or, in a repository that
 * marks none, one whose name says release, deploy or promote.
 */
export type ReleaseRun = {
  repo: string;
  id: number;
  /** The workflow's name, such as "Release". */
  workflow: string;
  /**
   * Its number among its workflow's runs, as GitHub shows it after the name: the 101 of "Release #101". Unset where
   * GitHub didn't say, such as a run the relay kept from before it read numbers.
   */
  number?: number | undefined;
  /** What the run is of: its display title on GitHub, such as the tag or the commit's subject. */
  title: string;
  /**
   * The release tag or version it is releasing, such as `v1.2.3`: the tag that started it, or the version its title
   * names when it was started by hand. Unset when the run doesn't say, such as one that makes its tag as it goes.
   */
  tag?: string | undefined;
  url: string;
  state: CheckState;
  /** Who started it. */
  actor: string | undefined;
  startedAt: string;
  /** Unset while it runs. */
  finishedAt: string | undefined;
  jobs: Job[];
  /**
   * The same jobs as its workflow file arranged them when the run started, on the default branch: which waits for
   * which. Unset when the file couldn't be read or understood; the jobs are then shown as they are listed.
   */
  graph?: JobGraph | undefined;
  /**
   * While it waits for an approval: the environments waiting for one, such as production. Read only for runs that
   * wait, so empty for every other run.
   */
  approvals: Approval[];
};

/** A run's jobs on its workflow's graph. Every job of the run is in exactly one node, or in `unplaced`. */
export type JobGraph = {
  /** The workflow file's jobs, in the file's order. */
  nodes: JobNode[];
  /** The run's jobs that match no job of the file, such as one the file has since lost. */
  unplaced: Job[];
};

/** One job of the workflow file, with the run's jobs that are it. */
export type JobNode = {
  /** Its id in the file, such as `build`. */
  key: string;
  /** What to call it: its name in the file, or its id when that name is worked out as it runs. */
  name: string;
  /** The keys of the jobs it waits for. */
  needs: string[];
  /** A matrix, or a call of a reusable workflow: one job in the file that runs as several. */
  several: boolean;
  /** The run's jobs of it: none yet for one not started, several for a matrix. */
  jobs: Job[];
};

/** One protected environment a waiting run needs approved before its job goes on. */
export type Approval = {
  environmentId: number;
  /** The environment's name, such as "production". */
  environment: string;
  /** Whether the signed-in user is one of its required reviewers, and so may approve or reject it. */
  canApprove: boolean;
};

// How many of a release workflow's latest runs are looked at. An older run still unfinished past these is left out,
// as a newer release replaces it.
export const RECENT_RELEASES = 5;

// The workflow a project's Promote button starts: it deploys a release that dev already has to production.
export const PROMOTE_WORKFLOW = ".github/workflows/promote.yml";

export type RawWorkflow = { id: number; name: string; state: string; path?: string };

export type RawRun = {
  id: number;
  name: string | null;
  display_title?: string;
  /** The branch or tag it ran on: the tag, for a run started by pushing one or by publishing a release. */
  head_branch?: string | null;
  /** What started it, such as `push`, `release` or `workflow_dispatch`. */
  event?: string;
  html_url: string;
  status: string | null;
  conclusion: string | null;
  actor?: { login: string } | null;
  triggering_actor?: { login: string } | null;
  created_at: string;
  run_started_at?: string | null;
  updated_at: string;
  head_sha?: string;
  /** Its number among its workflow's runs, such as 101 for "Release #101". */
  run_number?: number;
  /** Which try of the run this is: 1, and one more for each re-run. */
  run_attempt?: number;
  /** Its workflow file, such as `.github/workflows/release.yml`. */
  path?: string;
};

export type RawJob = {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  html_url: string | null;
  started_at: string | null;
  completed_at: string | null;
};

export type RawPendingDeployment = {
  environment: { id: number; name?: string };
  current_user_can_approve: boolean;
};

/** The state of a check run, a workflow run or a job, which all use the same words for status and conclusion. */
export function checkState(status: string | null, conclusion: string | null): CheckState {
  if (status !== "completed") {
    switch (status) {
      case "in_progress":
        return "running";
      // Waiting for an approval, such as a protected environment's.
      case "waiting":
        return "waiting";
      // queued, requested, pending
      default:
        return "queued";
    }
  }
  switch (conclusion) {
    case "success":
      return "passed";
    case "cancelled":
      return "cancelled";
    case "skipped":
      return "skipped";
    case "neutral":
      return "neutral";
    // failure, timed_out, startup_failure, and action_required and stale, which stop a merge like a failure does.
    default:
      return "failed";
  }
}

/** Of a workflow's latest runs: the unfinished ones, and the latest finished one so its outcome stays up. */
export function shownRuns<T extends { id: number; status: string | null }>(runs: T[]): T[] {
  const shown = runs.filter((run) => run.status !== "completed");
  const finished = runs.filter((run) => run.status === "completed");
  if (finished.length > 0) {
    shown.push(finished.reduce((a, b) => (b.id > a.id ? b : a)));
  }
  return shown;
}

export function isWaiting(job: Job): boolean {
  return job.state === "waiting";
}

/**
 * A run's jobs, given the `approvals` it waits for. GitHub calls a job waiting whatever it waits for, a runner as
 * much as an approval, so with nothing to approve its waiting jobs are queued ones. With `approvals` unset, for a run
 * whose approvals couldn't be read, GitHub's word stands.
 */
export function settledJobs(jobs: Job[], approvals: Approval[] | undefined): Job[] {
  if (approvals === undefined || approvals.length > 0) {
    return jobs;
  }
  return jobs.map((one) => (isWaiting(one) ? { ...one, state: "queued" } : one));
}

/**
 * How a run stands, given its jobs as `settledJobs` left them. A run with one job waiting for approval and another
 * running is "in progress" to GitHub, but what it needs is the approval. A run GitHub calls waiting with no job
 * waiting for an approval is waiting for something else, such as a runner, and stands as its jobs do.
 */
export function runState(run: Pick<RawRun, "status" | "conclusion">, jobs: Job[]): CheckState {
  const state = checkState(run.status, run.conclusion);
  if (run.status === "completed") {
    return state;
  }
  if (jobs.some(isWaiting)) {
    return "waiting";
  }
  if (state !== "waiting") {
    return state;
  }
  return jobs.some((one) => one.state === "running") ? "running" : "queued";
}

/**
 * A run of a release workflow as GitHub gives it, in the model's words: with its `jobs`, its workflow file's
 * `definitions` at its commit if they could be had, and the `approvals` it waits for (unset if they couldn't be read).
 * Only a run with something to approve, or whose approvals couldn't be read, is waiting: see `settledJobs`.
 */
export function runOf(
  repo: string,
  workflow: Pick<RawWorkflow, "name">,
  run: RawRun,
  listed: Job[],
  definitions: WorkflowJob[] | undefined,
  approvals: Approval[] | undefined,
): ReleaseRun {
  const jobs = settledJobs(listed, approvals);
  return {
    repo,
    id: run.id,
    workflow: workflow.name,
    ...(run.run_number === undefined ? {} : { number: run.run_number }),
    title: run.display_title ?? run.name ?? workflow.name,
    tag: releaseTag(run),
    url: run.html_url,
    state: runState(run, jobs),
    actor: (run.triggering_actor ?? run.actor)?.login,
    startedAt: run.run_started_at ?? run.created_at,
    finishedAt: run.status === "completed" ? run.updated_at : undefined,
    jobs,
    graph: definitions && jobGraph(definitions, jobs),
    approvals: approvals ?? [],
  };
}

// A tag that is a version, such as v1.2.3, 2.0 or v3.0.0-rc.1.
const VERSION_TAG = /^v?\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.+-]+)?$/;

// A version named in a run's title, such as the one in "Promote v1.2.3": three parts, so a date or a decimal isn't one.
const VERSION_IN_TITLE = /(?:^|[\s(@/])(v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]*[0-9A-Za-z])?)(?=$|[\s),:;])/;

/**
 * The release tag or version a run is releasing, from what its run says:
 *
 * - A run started by pushing a tag or publishing a release runs on that tag, which is its `head_branch`.
 * - A run started by hand, or by another workflow, runs on a branch; its title is its `run-name`, such as
 *   "Promote v1.2.3", so a version in it is the one it releases. A pushed commit's title is its subject, which can
 *   name any version (a dependency bump, say), so it isn't read for one.
 */
export function releaseTag(run: Pick<RawRun, "head_branch" | "event" | "display_title">): string | undefined {
  if (run.head_branch && VERSION_TAG.test(run.head_branch)) {
    return run.head_branch;
  }
  if (run.event === "push" || run.event === "pull_request" || !run.display_title) {
    return undefined;
  }
  return VERSION_IN_TITLE.exec(run.display_title)?.[1];
}

/** A pending deployment as GitHub lists it, in the model's words. */
export function approval(raw: RawPendingDeployment): Approval {
  return {
    environmentId: raw.environment.id,
    environment: raw.environment.name ?? `environment ${raw.environment.id}`,
    canApprove: raw.current_user_can_approve,
  };
}

export function job(raw: RawJob): Job {
  const state = checkState(raw.status, raw.conclusion);
  return {
    id: raw.id,
    name: raw.name,
    state,
    url: raw.html_url ?? undefined,
    // GitHub gives a job that hasn't started the time it was queued.
    startedAt: state === "queued" || state === "waiting" ? undefined : (raw.started_at ?? undefined),
    finishedAt: raw.completed_at ?? undefined,
  };
}

/**
 * Everything the relay knows of release runs at one moment, as it tells the page (see relay/src/events.ts). The
 * lists are complete: a run missing from `runs` is gone.
 */
export type ReleasesSnapshot = {
  /** Whether the relay can read GitHub at all. Without that it knows of no release runs. */
  configured: boolean;
  /** Per repository (`owner/name`) the relay has read. */
  projects: Record<string, { /** The id of its active Promote workflow, when it has one. */ promoteWorkflow?: number }>;
  /** Per release workflow: the runs still going, and the last one that finished. */
  runs: ReleaseRun[];
};
