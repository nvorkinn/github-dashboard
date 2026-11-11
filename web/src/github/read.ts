import type {
  Approval,
  Check,
  CheckState,
  DashboardData,
  Job,
  MergeMethod,
  Project,
  PullRequest,
  ReleaseRun,
} from "../model.ts";
import { type Api, GitHubError } from "./api.ts";
import type { Change } from "./events.ts";
import { jobGraph, markedReleaseFiles, WORKFLOWS_FOLDER, workflowFile } from "./workflow_graph.ts";

// How many of a release workflow's latest runs are looked at. An older run still unfinished past these is left out,
// as a newer release replaces it.
export const RECENT_RELEASES = 5;
// The workflow a project's Promote button starts: it deploys a release that dev already has to production.
export const PROMOTE_WORKFLOW = ".github/workflows/promote.yml";

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
  // Only in some answers (a repository's own page, for a user who can push to it), so each may be missing.
  allow_merge_commit?: boolean;
  allow_squash_merge?: boolean;
  allow_rebase_merge?: boolean;
  allow_auto_merge?: boolean;
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
  node_id: string;
};
type RawCheckRun = { name: string; status: string; conclusion: string | null; html_url: string | null };
type RawStatus = { context: string; state: string; target_url: string | null };
type RawWorkflow = { id: number; name: string; state: string; path?: string };
type RawRun = {
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
  /** Its workflow file, such as `.github/workflows/release.yml`. */
  path?: string;
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
export type RawPendingDeployment = {
  environment: { id: number; name?: string };
  current_user_can_approve: boolean;
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
  const read = await Promise.all(
    repos.map(async (repo) => {
      const [parts, settings] = await Promise.all([
        readRepo(api, repo.full_name, ALL_OF_IT, previous, failed),
        mergeSettings(api, repo, previous),
      ]);
      return { ...parts, project: project(repo, parts.latestRelease, settings, parts.promoteWorkflow) };
    }),
  );
  return {
    data: {
      projects: read.map((one) => one.project),
      pulls: read.flatMap((one) => one.pulls),
      releases: read.flatMap((one) => one.releases),
    },
    problem: problemOf(failed),
  };
}

/** What to read again of one repository. */
export type RepoPlan = {
  /** `all`: the list of open pull requests and each one on it. Otherwise only the ones with these numbers. */
  pulls: "all" | Set<number>;
  /** The runs of its release workflows. */
  releases: boolean;
  latestRelease: boolean;
};

/** What to read again: everything, or these parts of these repositories (`owner/name`). */
export type Plan = "everything" | Map<string, RepoPlan>;

const ALL_OF_IT: RepoPlan = { pulls: "all", releases: true, latestRelease: true };

// The kinds of change that can add, remove or rename a project: all of it is read again.
const WHICH_PROJECTS = new Set(["repository", "installation", "installation_repositories"]);

// The kinds of change that something on the page shows. `planFor` says what each one reads.
const SHOWN = new Set([
  "pull_request",
  "pull_request_review",
  "pull_request_review_thread",
  "check_run",
  "check_suite",
  "status",
  "workflow_run",
  "workflow_job",
  "deployment_review",
  "push",
  "release",
]);

/**
 * What a batch of changes asks to be read again, given what is `known` now. A busy CI run sends dozens of them, so
 * each one reads as little as shows it:
 *
 * - `pull_request`, `pull_request_review`, `pull_request_review_thread`, `check_run`, `check_suite`, `status`: the
 *   pull request it is about, with its checks.
 * - `workflow_run`, `workflow_job`, `deployment_review`: the repository's release runs, and the pull request it is
 *   about.
 * - `push`: every pull request of the repository, as a base that moved changes whether they can be merged.
 * - `release`: the repository's latest release.
 *
 * The pull request a change is about is the one it numbers, or else the ones whose head is its commit: none for a
 * check on the default branch, which is most of them. A change that names neither is about all of the repository's.
 *
 * The kinds that change which repositories there are (`repository`, `installation`, `installation_repositories`)
 * read everything, and so does one of the kinds above that names no repository or one that isn't known. Any other
 * kind reads nothing.
 */
export function planFor(changes: Change[], known: DashboardData): Plan {
  const plan = new Map<string, RepoPlan>();
  for (const change of changes) {
    if (WHICH_PROJECTS.has(change.kind)) {
      return "everything";
    }
    // GitHub sends an App more kinds than it asked for. Nothing on the page shows what these say.
    if (!SHOWN.has(change.kind)) {
      continue;
    }
    const name = change.repo;
    // A project the page doesn't know yet.
    if (name === undefined || !known.projects.some(of(name))) {
      return "everything";
    }
    const repo = plan.get(name) ?? { pulls: new Set<number>(), releases: false, latestRelease: false };
    plan.set(name, repo);
    switch (change.kind) {
      case "pull_request":
      case "pull_request_review":
      case "pull_request_review_thread":
      case "check_run":
      case "check_suite":
      case "status":
        repo.pulls = both(repo.pulls, pullsOf(change, known));
        break;
      case "workflow_run":
      case "workflow_job":
      case "deployment_review":
        repo.releases = true;
        repo.pulls = both(repo.pulls, pullsOf(change, known));
        break;
      case "push":
        repo.pulls = "all";
        break;
      case "release":
        repo.latestRelease = true;
        break;
    }
  }
  // Such as a check on a commit that no pull request has as its head: nothing on the page shows it.
  for (const [name, repo] of plan) {
    if (repo.pulls !== "all" && repo.pulls.size === 0 && !repo.releases && !repo.latestRelease) {
      plan.delete(name);
    }
  }
  return plan;
}

/** The pull requests of its repository that a change is about. */
function pullsOf(change: Change, known: DashboardData): RepoPlan["pulls"] {
  if (change.pull !== undefined) {
    return new Set([change.pull]);
  }
  if (change.sha === undefined) {
    return "all";
  }
  return new Set(
    known.pulls.filter((pull) => pull.repo === change.repo && pull.sha === change.sha).map((pull) => pull.number),
  );
}

function both(a: RepoPlan["pulls"], b: RepoPlan["pulls"]): RepoPlan["pulls"] {
  return a === "all" || b === "all" ? "all" : new Set([...a, ...b]);
}

/**
 * Reads only what `plan` names and puts it into a copy of `previous`; the rest stays as it was. The projects stay
 * the same ones, so a plan is only for changes that can't add or remove one. Fails the way `readDashboard` does: a
 * part GitHub refuses stays as it was and is a `problem`, and what would fail every call is thrown.
 */
export async function readChanged(api: Api, plan: Map<string, RepoPlan>, previous: DashboardData): Promise<ReadResult> {
  const failed = new Set<string>();
  const read = new Map(
    await Promise.all(
      [...plan].map(async ([name, wanted]) => [name, await readRepo(api, name, wanted, previous, failed)] as const),
    ),
  );
  const projects = previous.projects.map((one) => {
    const parts = read.get(one.repo);
    return parts ? { ...one, latestRelease: parts.latestRelease, promoteWorkflow: parts.promoteWorkflow } : one;
  });
  return {
    data: {
      projects,
      pulls: projects.flatMap((one) => read.get(one.repo)?.pulls ?? previous.pulls.filter(of(one.repo))),
      releases: projects.flatMap((one) => read.get(one.repo)?.releases ?? previous.releases.filter(of(one.repo))),
    },
    problem: problemOf(failed),
  };
}

function of(repo: string): (one: { repo: string }) => boolean {
  return (one) => one.repo === repo;
}

function problemOf(failed: Set<string>): string | undefined {
  const names = [...failed];
  return names.length === 0
    ? undefined
    : `Couldn't read everything from ${names.length === 1 ? names[0] : `${names.length} projects`}.`;
}

type RepoParts = {
  latestRelease: Project["latestRelease"];
  pulls: PullRequest[];
  releases: ReleaseRun[];
  promoteWorkflow: Project["promoteWorkflow"];
};

/**
 * The parts of one repository: read if `wanted` names them, and as they were in `previous` otherwise. A part that
 * GitHub refuses, and only that part, also stays as it was, and its repository is added to `failed`.
 */
async function readRepo(
  api: Api,
  repo: string,
  wanted: RepoPlan,
  previous: DashboardData | undefined,
  failed: Set<string>,
): Promise<RepoParts> {
  const was: RepoParts = {
    latestRelease: previous?.projects.find(of(repo))?.latestRelease,
    pulls: previous?.pulls.filter(of(repo)) ?? [],
    releases: previous?.releases.filter(of(repo)) ?? [],
    promoteWorkflow: previous?.projects.find(of(repo))?.promoteWorkflow,
  };

  async function part<T>(isWanted: boolean, read: () => Promise<T>, fallback: T): Promise<T> {
    if (!isWanted) {
      return fallback;
    }
    try {
      return await read();
    } catch (error) {
      if (!refused(error)) {
        throw error;
      }
      failed.add(repo);
      return fallback;
    }
  }

  const numbers = wanted.pulls;
  const [latestRelease, pulls, releases] = await Promise.all([
    part(wanted.latestRelease, () => latest(api, repo), was.latestRelease),
    part(
      numbers === "all" || numbers.size > 0,
      () => (numbers === "all" ? pullRequests(api, repo) : somePullRequests(api, repo, numbers, was.pulls)),
      was.pulls,
    ),
    // The Promote workflow is found in the same list of workflows as the release workflows.
    part(wanted.releases, () => releaseRuns(api, repo), { runs: was.releases, promoteWorkflow: was.promoteWorkflow }),
  ]);
  return { latestRelease, pulls, releases: releases.runs, promoteWorkflow: releases.promoteWorkflow };
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

type MergeSettings = Pick<Project, "mergeMethod" | "autoMergeAllowed">;

const MERGE_SETTINGS = ["allow_merge_commit", "allow_squash_merge", "allow_rebase_merge", "allow_auto_merge"] as const;

/**
 * How the repository's pull requests are merged. The list of repositories may carry its settings; if it doesn't,
 * they are on the repository's own page, which is one request more per repository (and mostly a 304, which GitHub
 * doesn't count). Settings that can't be read are what they were, or else count as allowed: GitHub's refusal then
 * says what isn't, when the user acts. Nothing on the page shows them, so they are no problem for it.
 */
async function mergeSettings(api: Api, repo: RawRepo, previous: DashboardData | undefined): Promise<MergeSettings> {
  if (MERGE_SETTINGS.every((key) => typeof repo[key] === "boolean")) {
    return settingsOf(repo);
  }
  try {
    return settingsOf(await api.get<RawRepo>(`repos/${repo.full_name}`));
  } catch (error) {
    if (!refused(error)) {
      throw error;
    }
    return previous?.projects.find(of(repo.full_name)) ?? settingsOf({});
  }
}

function settingsOf(repo: Partial<RawRepo>): MergeSettings {
  return { mergeMethod: mergeMethod(repo), autoMergeAllowed: repo.allow_auto_merge !== false };
}

/**
 * The first merge method the repository allows, preferring a merge commit, as countdown-server's dashboard did. A
 * setting that isn't known counts as allowed.
 */
export function mergeMethod(repo: Partial<Pick<RawRepo, (typeof MERGE_SETTINGS)[number]>>): MergeMethod {
  if (repo.allow_merge_commit !== false) {
    return "merge";
  }
  if (repo.allow_squash_merge !== false) {
    return "squash";
  }
  if (repo.allow_rebase_merge !== false) {
    return "rebase";
  }
  return "merge";
}

/** Whether `error` is GitHub refusing one read, rather than something that fails every call. */
function refused(error: unknown): boolean {
  return error instanceof GitHubError && error.retryAt === undefined && error.status !== 401;
}

function project(
  repo: RawRepo,
  latestRelease: Project["latestRelease"],
  settings: MergeSettings,
  promoteWorkflow: Project["promoteWorkflow"],
): Project {
  return {
    repo: repo.full_name,
    name: repo.name,
    description: repo.description ?? undefined,
    url: repo.html_url,
    defaultBranch: repo.default_branch,
    private: repo.private,
    pushedAt: repo.pushed_at ?? undefined,
    latestRelease,
    mergeMethod: settings.mergeMethod,
    autoMergeAllowed: settings.autoMergeAllowed,
    promoteWorkflow,
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

/**
 * `known` with the pull requests of these numbers read again: each one as it is now, gone if it closed, or new at
 * the front, where GitHub's list has the newest.
 */
async function somePullRequests(
  api: Api,
  repo: string,
  numbers: Set<number>,
  known: PullRequest[],
): Promise<PullRequest[]> {
  const read = new Map(
    await Promise.all([...numbers].map(async (number) => [number, await pullRequest(api, repo, number)] as const)),
  );
  const added = [...numbers]
    .filter((number) => !known.some((pull) => pull.number === number))
    .sort((a, b) => b - a)
    .map((number) => read.get(number));
  const kept = known.map((pull) => (read.has(pull.number) ? read.get(pull.number) : pull));
  return [...added, ...kept].filter((pull) => pull !== undefined);
}

/** One pull request with its checks, as it is now; undefined if it is closed or gone. */
export async function pullRequest(api: Api, repo: string, number: number): Promise<PullRequest | undefined> {
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
    nodeId: pull.node_id,
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

/**
 * Whether a workflow's name makes it a release: a release, a promotion or a deploy. Only a guess, used for a
 * repository that marks none of its workflow files (see `releaseWorkflows`).
 */
export function isReleaseName(name: string | null | undefined): boolean {
  const lower = (name ?? "").toLowerCase();
  return lower.includes("release") || lower.includes("promote") || lower.includes("deploy");
}

/**
 * Of a repository's workflows, the ones whose runs the dashboard shows as releases. Only a workflow with a file in
 * the repository counts, so not the ones GitHub runs by itself, such as "pages build and deployment". Of those:
 * the ones whose file carries the mark, a comment line `# dashboard: release`; and in a repository that marks none,
 * the ones whose name says release, promote or deploy.
 */
export async function releaseWorkflows<T extends { name: string; path?: string | undefined }>(
  api: Api,
  repo: string,
  workflows: T[],
): Promise<T[]> {
  const withFile = workflows.filter((workflow) => workflow.path?.startsWith(`${WORKFLOWS_FOLDER}/`));
  if (withFile.length === 0) {
    return [];
  }
  const marked = await markedReleaseFiles(api, repo);
  return marked.size > 0
    ? withFile.filter((workflow) => marked.has(workflow.path ?? ""))
    : withFile.filter((workflow) => isReleaseName(workflow.name));
}

/**
 * Per release workflow, the runs still going among its latest ones and the last one that finished, the last started
 * first. Read per workflow, so CI runs can't push a release off the page. With them, from the same list of
 * workflows, the id of the repository's active Promote workflow, if it has one.
 */
async function releaseRuns(
  api: Api,
  repo: string,
): Promise<{ runs: ReleaseRun[]; promoteWorkflow: number | undefined }> {
  // A disabled workflow starts no more releases.
  const active = (await api.list<RawWorkflow>(`repos/${repo}/actions/workflows`, "workflows")).filter(
    (workflow) => workflow.state === "active",
  );
  const workflows = await releaseWorkflows(api, repo, active);
  const promoteWorkflow = active.find((workflow) => workflow.path === PROMOTE_WORKFLOW)?.id;
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
  return { runs: runs.flat().sort((a, b) => b.startedAt.localeCompare(a.startedAt)), promoteWorkflow };
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
  const path = run.path ?? workflow.path;
  const [rawJobs, definitions] = await Promise.all([
    // Without `filter`, GitHub gives the jobs of the run's latest attempt.
    api.list<RawJob>(`repos/${repo}/actions/runs/${run.id}/jobs`, "jobs"),
    // Which job waits for which, from the workflow file as it was at the run's commit.
    path && run.head_sha ? workflowFile(api, repo, path, run.head_sha) : undefined,
  ]);
  const jobs = rawJobs.map(job);
  let state = checkState(run.status, run.conclusion);
  // A run with one job waiting for approval and another running is "in progress" to GitHub, but what it needs is
  // the approval.
  if (run.status !== "completed" && jobs.some((one) => one.state === "waiting")) {
    state = "waiting";
  }
  // Only a run that waits has anything to approve, so only such a run costs the request.
  const approvals = state === "waiting" ? await pendingApprovals(api, repo, run.id) : [];
  return {
    repo,
    id: run.id,
    workflow: workflow.name,
    title: run.display_title ?? run.name ?? workflow.name,
    tag: releaseTag(run),
    url: run.html_url,
    state,
    actor: (run.triggering_actor ?? run.actor)?.login,
    startedAt: run.run_started_at ?? run.created_at,
    finishedAt: run.status === "completed" ? run.updated_at : undefined,
    jobs,
    graph: definitions && jobGraph(definitions, jobs),
    approvals,
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

/**
 * The environments a waiting run needs approved. A token without the permission to read them (GitHub answers 403 or
 * 404) leaves the run without buttons rather than without its card.
 */
async function pendingApprovals(api: Api, repo: string, run: number): Promise<Approval[]> {
  let pending: RawPendingDeployment[];
  try {
    pending = await api.list<RawPendingDeployment>(`repos/${repo}/actions/runs/${run}/pending_deployments`);
  } catch (error) {
    if (error instanceof GitHubError && error.retryAt === undefined && (error.status === 403 || error.status === 404)) {
      return [];
    }
    throw error;
  }
  return pending.map(approval);
}

/** A pending deployment as GitHub lists it, in the model's words. */
export function approval(raw: RawPendingDeployment): Approval {
  return {
    environmentId: raw.environment.id,
    environment: raw.environment.name ?? `environment ${raw.environment.id}`,
    canApprove: raw.current_user_can_approve,
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
