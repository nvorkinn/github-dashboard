import type { Check, CheckState, DashboardData, Job, Project, PullRequest, ReleaseRun } from "../model.ts";
import { type Api, GitHubError } from "./api.ts";

// How many of a release workflow's latest runs are looked at. An older run still unfinished past these is left out,
// as a newer release replaces it.
export const RECENT_RELEASES = 5;

// The parts of GitHub's answers that are used. Everything else in them is ignored.
type RawInstallation = { id: number };
type RawRepo = {
  full_name: string;
  name: string;
  description: string | null;
  html_url: string;
  default_branch: string;
  private: boolean;
  archived: boolean;
  pushed_at: string | null;
};
type RawRelease = { tag_name: string; html_url: string; published_at: string | null; created_at: string };
type RawPull = {
  number: number;
  state: string;
  title: string;
  html_url: string;
  user: { login: string; avatar_url?: string } | null;
  draft?: boolean;
  head: { ref: string; sha: string };
  base: { ref: string };
  created_at: string;
  updated_at: string;
  mergeable?: boolean | null;
  mergeable_state?: string;
  auto_merge?: object | null;
};
type RawCheckRun = { name: string; status: string; conclusion: string | null; html_url: string | null };
type RawStatus = { context: string; state: string; target_url: string | null };
type RawWorkflow = { id: number; name: string; state: string };
type RawRun = {
  id: number;
  name: string | null;
  display_title?: string;
  html_url: string;
  status: string | null;
  conclusion: string | null;
  actor?: { login: string } | null;
  triggering_actor?: { login: string } | null;
  created_at: string;
  run_started_at?: string | null;
  updated_at: string;
};
type RawJob = {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  html_url: string | null;
  started_at: string | null;
  completed_at: string | null;
};

export type ReadResult = {
  data: DashboardData;
  /** Set when part of it couldn't be read: words for the user. */
  problem: string | undefined;
};

/**
 * Reads everything the dashboard shows. A project whose pull requests, releases or latest release can't be read
 * doesn't take the others down: that part stays as it was in `previous` (or empty on a first read) and `problem`
 * says so. A rate limit, a sign-in GitHub no longer accepts or a failing network is thrown instead, as every other
 * call would fail the same way.
 */
export async function readDashboard(api: Api, previous?: DashboardData): Promise<ReadResult> {
  const repos = await repositories(api);
  const failed = new Set<string>();

  /** `read`'s result, or `fallback` and a note of the project if GitHub refuses just this. */
  async function part<T>(repo: RawRepo, read: () => Promise<T>, fallback: () => T): Promise<T> {
    try {
      return await read();
    } catch (error) {
      if (!(error instanceof GitHubError) || error.retryAt !== undefined || error.status === 401) {
        throw error;
      }
      failed.add(repo.full_name);
      return fallback();
    }
  }

  const read = await Promise.all(
    repos.map(async (repo) => {
      const name = repo.full_name;
      const [latestRelease, pulls, releases] = await Promise.all([
        part(
          repo,
          () => latest(api, name),
          () => previous?.projects.find((project) => project.repo === name)?.latestRelease,
        ),
        part(
          repo,
          () => pullRequests(api, name),
          () => previous?.pulls.filter((pull) => pull.repo === name) ?? [],
        ),
        part(
          repo,
          () => releaseRuns(api, name),
          () => previous?.releases.filter((run) => run.repo === name) ?? [],
        ),
      ]);
      return { project: project(repo, latestRelease), pulls, releases };
    }),
  );

  const names = [...failed];
  return {
    data: {
      projects: read.map((one) => one.project),
      pulls: read.flatMap((one) => one.pulls),
      releases: read.flatMap((one) => one.releases),
    },
    problem:
      names.length === 0
        ? undefined
        : `Couldn't read everything from ${names.length === 1 ? names[0] : `${names.length} projects`}.`,
  };
}

/**
 * The repositories the GitHub App is installed on and the user can reach, the last pushed first. A user token of a
 * GitHub App sees repositories through the app's installations; `user/repos` isn't for it.
 */
async function repositories(api: Api): Promise<RawRepo[]> {
  const installations = await api.list<RawInstallation>("user/installations", "installations");
  const lists = await Promise.all(
    installations.map((installation) =>
      api.list<RawRepo>(`user/installations/${installation.id}/repositories`, "repositories"),
    ),
  );
  const repos = new Map<string, RawRepo>();
  for (const repo of lists.flat()) {
    if (!repo.archived) {
      repos.set(repo.full_name, repo);
    }
  }
  return [...repos.values()].sort((a, b) => (b.pushed_at ?? "").localeCompare(a.pushed_at ?? ""));
}

function project(repo: RawRepo, latestRelease: Project["latestRelease"]): Project {
  return {
    repo: repo.full_name,
    name: repo.name,
    description: repo.description ?? undefined,
    url: repo.html_url,
    defaultBranch: repo.default_branch,
    private: repo.private,
    pushedAt: repo.pushed_at ?? undefined,
    latestRelease,
  };
}

async function latest(api: Api, repo: string): Promise<Project["latestRelease"]> {
  // GitHub answers 404 for a repository without a published release.
  const release = await unlessGone(api.get<RawRelease>(`repos/${repo}/releases/latest`));
  return (
    release && {
      tag: release.tag_name,
      url: release.html_url,
      publishedAt: release.published_at ?? release.created_at,
    }
  );
}

async function unlessGone<T>(reading: Promise<T>): Promise<T | undefined> {
  try {
    return await reading;
  } catch (error) {
    if (error instanceof GitHubError && error.status === 404) {
      return undefined;
    }
    throw error;
  }
}

/** Every open pull request with its checks, leaving out any that closed while being read. */
async function pullRequests(api: Api, repo: string): Promise<PullRequest[]> {
  const open = await api.list<RawPull>(`repos/${repo}/pulls?state=open`);
  const pulls = await Promise.all(open.map((pull) => pullRequest(api, repo, pull.number)));
  return pulls.filter((pull) => pull !== undefined);
}

async function pullRequest(api: Api, repo: string, number: number): Promise<PullRequest | undefined> {
  // The list doesn't say whether a pull request can be merged; only its own page does.
  const pull = await unlessGone(api.get<RawPull>(`repos/${repo}/pulls/${number}`));
  if (pull?.state !== "open") {
    return undefined;
  }
  const sha = pull.head.sha;
  const [checkRuns, statuses] = await Promise.all([
    // `latest` leaves out the runs a re-run replaced.
    api.list<RawCheckRun>(`repos/${repo}/commits/${sha}/check-runs?filter=latest`, "check_runs"),
    api.list<RawStatus>(`repos/${repo}/commits/${sha}/statuses`),
  ]);
  return {
    repo,
    number: pull.number,
    title: pull.title,
    url: pull.html_url,
    author: pull.user?.login ?? "ghost",
    authorAvatarUrl: pull.user?.avatar_url,
    draft: pull.draft ?? false,
    head: pull.head.ref,
    base: pull.base.ref,
    sha,
    createdAt: pull.created_at,
    updatedAt: pull.updated_at,
    mergeState: mergeState(pull),
    autoMerge: pull.auto_merge != null,
    checks: checks(checkRuns, statuses),
  };
}

/**
 * GitHub's `mergeable_state` in the model's words. `has_hooks` is mergeable with pre-receive hooks to pass, and
 * `unstable` is mergeable with checks that failed but aren't required, so both are `clean`: the checks show the
 * failure themselves. A draft can't be merged until it is marked ready, so it is `blocked`.
 */
export function mergeState(pull: { mergeable?: boolean | null; mergeable_state?: string }): PullRequest["mergeState"] {
  // GitHub works mergeability out in the background; until then `mergeable` is null.
  if (pull.mergeable == null) {
    return "unknown";
  }
  switch (pull.mergeable_state) {
    case "clean":
    case "has_hooks":
    case "unstable":
      return "clean";
    case "dirty":
      return "conflicts";
    case "behind":
      return "behind";
    case "blocked":
    case "draft":
      return "blocked";
    default:
      return "unknown";
  }
}

export function checks(checkRuns: RawCheckRun[], statuses: RawStatus[]): Check[] {
  const found: Check[] = checkRuns.map((run) => ({
    name: run.name,
    state: checkState(run.status, run.conclusion),
    url: run.html_url ?? undefined,
  }));
  // The statuses come newest first and include the earlier updates of the same context, so the first one counts.
  const seen = new Set<string>();
  for (const status of statuses) {
    if (!seen.has(status.context)) {
      seen.add(status.context);
      found.push({ name: status.context, state: statusState(status.state), url: status.target_url ?? undefined });
    }
  }
  return found;
}

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

/** The state of a commit status. It has no word for queued, so `pending` counts as running. */
function statusState(state: string): CheckState {
  switch (state) {
    case "success":
      return "passed";
    case "pending":
      return "running";
    // failure, error
    default:
      return "failed";
  }
}

/** Whether a workflow's name makes it a release the dashboard shows: a release, a promotion or a deploy. */
export function isReleaseName(name: string | null | undefined): boolean {
  const lower = (name ?? "").toLowerCase();
  return lower.includes("release") || lower.includes("promote") || lower.includes("deploy");
}

/**
 * Per release workflow, the runs still going among its latest ones and the last one that finished, the last started
 * first. Read per workflow, so CI runs can't push a release off the page.
 */
async function releaseRuns(api: Api, repo: string): Promise<ReleaseRun[]> {
  const workflows = (await api.list<RawWorkflow>(`repos/${repo}/actions/workflows`, "workflows")).filter(
    // A disabled workflow starts no more releases.
    (workflow) => workflow.state === "active" && isReleaseName(workflow.name),
  );
  const runs = await Promise.all(
    workflows.map(async (workflow) => {
      const latestRuns = (
        await api.get<{ workflow_runs: RawRun[] }>(
          `repos/${repo}/actions/workflows/${workflow.id}/runs?per_page=${RECENT_RELEASES}`,
        )
      ).workflow_runs;
      return Promise.all(shownRuns(latestRuns).map((run) => releaseRun(api, repo, workflow, run)));
    }),
  );
  return runs.flat().sort((a, b) => b.startedAt.localeCompare(a.startedAt));
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

async function releaseRun(api: Api, repo: string, workflow: RawWorkflow, run: RawRun): Promise<ReleaseRun> {
  // Without `filter`, GitHub gives the jobs of the run's latest attempt.
  const rawJobs = await api.list<RawJob>(`repos/${repo}/actions/runs/${run.id}/jobs`, "jobs");
  const jobs = rawJobs.map(job);
  let state = checkState(run.status, run.conclusion);
  // A run with one job waiting for approval and another running is "in progress" to GitHub, but what it needs is
  // the approval.
  if (run.status !== "completed" && jobs.some((one) => one.state === "waiting")) {
    state = "waiting";
  }
  return {
    repo,
    id: run.id,
    workflow: workflow.name,
    title: run.display_title ?? run.name ?? workflow.name,
    url: run.html_url,
    state,
    actor: (run.triggering_actor ?? run.actor)?.login,
    startedAt: run.run_started_at ?? run.created_at,
    finishedAt: run.status === "completed" ? run.updated_at : undefined,
    jobs,
  };
}

function job(raw: RawJob): Job {
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
