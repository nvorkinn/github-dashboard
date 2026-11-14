import { approval, checkState, type RawPendingDeployment } from "../../../shared/runs.ts";
import type {
  Approval,
  Check,
  CheckState,
  DashboardData,
  MergeMethod,
  Project,
  PullRequest,
  Unreleased,
} from "../model.ts";
import { type Api, GitHubError } from "./api.ts";
import type { Change } from "./events.ts";
import { comparisonField, type GqlComparison, unreleasedFrom } from "./unreleased.ts";

// The parts of GitHub's answers that are used. Everything else in them is ignored.
export type RawRepo = {
  full_name: string;
  name: string;
  html_url: string;
  private: boolean;
  archived: boolean;
  pushed_at: string | null;
  default_branch?: string;
  // Only in some answers (a repository's own page, for a user who can push to it), so each may be missing.
  allow_merge_commit?: boolean;
  allow_squash_merge?: boolean;
  allow_rebase_merge?: boolean;
  allow_auto_merge?: boolean;
};
export type RawRelease = { tag_name: string; html_url: string; published_at: string | null; created_at: string };
export type RawPull = {
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
export type RawCheckRun = { name: string; status: string; conclusion: string | null; html_url: string | null };
export type RawStatus = { context: string; state: string; target_url: string | null };

export type ReadResult = {
  data: DashboardData;
  /** Set when part of it couldn't be read: words for the user. */
  problem: string | undefined;
};

/** What to read again of one repository. */
export type RepoPlan = {
  /** `all`: the list of open pull requests and each one on it. Otherwise only the ones with these numbers. */
  pulls: "all" | Set<number>;
  /** The latest release, and what the default branch has that it hasn't. */
  latestRelease: boolean;
};

/** What to read again: everything, or these parts of these repositories (`owner/name`). */
export type Plan = "everything" | Map<string, RepoPlan>;

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
  "push",
  "release",
]);

/**
 * What a batch of changes asks to be read again, given what is `known` now. A busy CI run sends dozens of them, so
 * each one reads as little as shows it:
 *
 * - `pull_request`, `pull_request_review`, `pull_request_review_thread`, `check_run`, `check_suite`, `status`: the
 *   pull request it is about, with its checks.
 * - `workflow_run`, `workflow_job`: the pull request it is about, with its checks. How a release run stands isn't
 *   read: the relay says (see dashboard.ts).
 * - `push`: every pull request of the repository, as a base that moved changes whether they can be merged; and the
 *   latest release, as the default branch may have moved past it.
 * - `release`: the repository's latest release.
 *
 * The pull request a change is about is the one it numbers, or else the ones whose head is its commit: none for a
 * check on the default branch, which is most of them. A change that names neither is about all of the repository's.
 *
 * A change in a project that is `hidden` reads nothing, as nothing of such a project is read.
 *
 * The kinds that change which repositories there are (`repository`, `installation`, `installation_repositories`)
 * read everything, and so does one of the kinds above that names no repository or one that isn't known. Any other
 * kind reads nothing.
 */
export function planFor(changes: Change[], known: DashboardData, hidden: ReadonlySet<string> = new Set()): Plan {
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
    // Nothing of a hidden project is read, so nothing of it is read again.
    if (name !== undefined && hidden.has(name) && known.projects.some(of(name))) {
      continue;
    }
    // A project the page doesn't know yet.
    if (name === undefined || !known.projects.some(of(name))) {
      return "everything";
    }
    const repo = plan.get(name) ?? { pulls: new Set<number>(), latestRelease: false };
    plan.set(name, repo);
    switch (change.kind) {
      case "pull_request":
      case "pull_request_review":
      case "pull_request_review_thread":
      case "check_run":
      case "check_suite":
      case "status":
      case "workflow_run":
      case "workflow_job":
        repo.pulls = both(repo.pulls, pullsOf(change, known));
        break;
      case "push":
        repo.pulls = "all";
        repo.latestRelease = true;
        break;
      case "release":
        repo.latestRelease = true;
        break;
    }
  }
  // Such as a check on a commit that no pull request has as its head: nothing on the page shows it.
  for (const [name, repo] of plan) {
    if (repo.pulls !== "all" && repo.pulls.size === 0 && !repo.latestRelease) {
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
 * Reads only what `plan` names and puts it into a copy of `previous`; the rest stays as it was, the release runs
 * among it, which are the relay's to say. The projects stay the same ones, so a plan is only for changes that can't add or remove one. Fails the way `readDashboard` does: a
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
    return parts ? { ...one, latestRelease: parts.latestRelease, unreleased: parts.unreleased } : one;
  });
  return {
    data: {
      projects,
      pulls: projects.flatMap((one) => read.get(one.repo)?.pulls ?? previous.pulls.filter(of(one.repo))),
      releases: previous.releases,
    },
    problem: problemOf(failed),
  };
}

export function of(repo: string): (one: { repo: string }) => boolean {
  return (one) => one.repo === repo;
}

export function problemOf(failed: Set<string>): string | undefined {
  const names = [...failed];
  return names.length === 0
    ? undefined
    : `Couldn't read everything from ${names.length === 1 ? names[0] : `${names.length} projects`}.`;
}

type RepoParts = {
  latestRelease: Project["latestRelease"];
  unreleased: Project["unreleased"];
  pulls: PullRequest[];
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
    unreleased: previous?.projects.find(of(repo))?.unreleased,
    pulls: previous?.pulls.filter(of(repo)) ?? [],
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
  const branch = previous?.projects.find(of(repo))?.defaultBranch;
  const [{ latestRelease, unreleased }, pulls] = await Promise.all([
    part(
      wanted.latestRelease,
      async () => {
        const found = await latest(api, repo);
        return { latestRelease: found, unreleased: await unreleasedOf(api, repo, found?.tag, branch) };
      },
      { latestRelease: was.latestRelease, unreleased: was.unreleased },
    ),
    part(
      numbers === "all" || numbers.size > 0,
      () => (numbers === "all" ? pullRequests(api, repo) : somePullRequests(api, repo, numbers, was.pulls)),
      was.pulls,
    ),
  ]);
  return { latestRelease, unreleased, pulls };
}

export type MergeSettings = Pick<Project, "mergeMethod" | "autoMergeAllowed">;

const MERGE_SETTINGS = ["allow_merge_commit", "allow_squash_merge", "allow_rebase_merge", "allow_auto_merge"] as const;

/** How the repository's pull requests are merged. A setting that isn't known counts as allowed: GitHub then says. */
export function settingsOf(repo: Partial<RawRepo>): MergeSettings {
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
export function refused(error: unknown): boolean {
  return error instanceof GitHubError && error.retryAt === undefined && error.status !== 401;
}

export function project(
  repo: RawRepo,
  latestRelease: Project["latestRelease"],
  settings: MergeSettings,
  promoteWorkflow: Project["promoteWorkflow"],
  unreleased: Project["unreleased"] = undefined,
): Project {
  return {
    repo: repo.full_name,
    name: repo.name,
    url: repo.html_url,
    private: repo.private,
    pushedAt: repo.pushed_at ?? undefined,
    latestRelease,
    defaultBranch: repo.default_branch,
    unreleased: latestRelease ? unreleased : undefined,
    mergeMethod: settings.mergeMethod,
    autoMergeAllowed: settings.autoMergeAllowed,
    promoteWorkflow,
  };
}

async function latest(api: Api, repo: string): Promise<Project["latestRelease"]> {
  // GitHub answers 404 for a repository without a published release.
  return latestOf(await unlessGone(api.get<RawRelease>(`repos/${repo}/releases/latest`)));
}

/**
 * What `branch` has that the release `tag` hasn't, from GitHub's comparison of the two; undefined without a release
 * or a branch to compare.
 */
async function unreleasedOf(
  api: Api,
  repo: string,
  tag: string | undefined,
  branch: string | undefined,
): Promise<Unreleased | undefined> {
  if (tag === undefined || branch === undefined) {
    return undefined;
  }
  const { data, errors } = await api.query(`query {\n  c0: ${comparisonField(repo, tag, branch)}\n}`);
  if (errors.length > 0) {
    throw new GitHubError("graphql", 502, undefined);
  }
  return unreleasedFrom(data.c0 as GqlComparison, branch);
}

export function latestOf(release: RawRelease | undefined): Project["latestRelease"] {
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
export async function pullRequests(api: Api, repo: string): Promise<PullRequest[]> {
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
  return pullOf(repo, pull, checkRuns, statuses);
}

/** An open pull request as GitHub gives it, with its head commit's check runs and statuses, in the model's words. */
export function pullOf(repo: string, pull: RawPull, checkRuns: RawCheckRun[], statuses: RawStatus[]): PullRequest {
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
    sha: pull.head.sha,
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
 * The environments a waiting run needs approved, and whether the signed-in user may approve each. A token without
 * the permission to read them (GitHub answers 403 or 404) gets nothing, which leaves the run without buttons.
 */
export async function pendingApprovals(api: Api, repo: string, run: number): Promise<Approval[] | undefined> {
  let pending: RawPendingDeployment[];
  try {
    pending = await api.list<RawPendingDeployment>(`repos/${repo}/actions/runs/${run}/pending_deployments`);
  } catch (error) {
    if (error instanceof GitHubError && error.retryAt === undefined && (error.status === 403 || error.status === 404)) {
      return undefined;
    }
    throw error;
  }
  return pending.map(approval);
}
