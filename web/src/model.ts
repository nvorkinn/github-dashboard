/**
 * What the dashboard shows, as plain data. The GitHub side (web/src/github/) fills it from api.github.com, the demo
 * fills it from sample data, and the components (web/src/components/) only draw it. Nothing here knows about HTTP.
 *
 * Times are ISO strings as GitHub gives them. Addresses ending in `Url` open the thing on github.com.
 */

/** How one check, job or run stands. `waiting` is waiting for an approval, such as a protected environment. */
export type CheckState = "queued" | "running" | "waiting" | "passed" | "failed" | "cancelled" | "skipped" | "neutral";

/** One check on a pull request's head commit: a check run, or an older commit status. */
export type Check = {
  name: string;
  state: CheckState;
  url: string | undefined;
};

export type PullRequest = {
  /** `owner/name`. */
  repo: string;
  number: number;
  title: string;
  url: string;
  author: string;
  authorAvatarUrl: string | undefined;
  draft: boolean;
  /** The branch it comes from and the one it goes into. */
  head: string;
  base: string;
  sha: string;
  createdAt: string;
  updatedAt: string;
  /**
   * Whether GitHub would merge it now: `clean` yes, `blocked` a rule or required check stands in the way,
   * `conflicts` it conflicts with its base, `behind` its base moved and the rules want it updated, `unknown` GitHub
   * is still working it out.
   */
  mergeState: "clean" | "blocked" | "conflicts" | "behind" | "unknown";
  autoMerge: boolean;
  checks: Check[];
  /** GitHub's global id for it, which its GraphQL API (auto-merge) asks for. */
  nodeId: string;
};

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
   * The same jobs as its workflow file arranges them, at the run's commit: which waits for which. Unset when the
   * file couldn't be read or understood; the jobs are then shown as they are listed.
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

export type Project = {
  /** `owner/name`. */
  repo: string;
  /** Just the name. */
  name: string;
  description: string | undefined;
  url: string;
  private: boolean;
  pushedAt: string | undefined;
  /** The newest published release, if there is one. */
  latestRelease: { tag: string; url: string; publishedAt: string } | undefined;
  /** How the page merges its pull requests: the first way the repository allows, a merge commit first. */
  mergeMethod: MergeMethod;
  /** Whether the repository allows auto-merge. True when its settings couldn't be read: GitHub then says. */
  autoMergeAllowed: boolean;
  /** The id of its active Promote workflow (`PROMOTE_WORKFLOW`), when it has one. */
  promoteWorkflow: number | undefined;
};

/** The ways GitHub merges a pull request. */
export type MergeMethod = "merge" | "squash" | "rebase";

/** Everything on the page at one moment. The lists are complete: something missing from them is gone. */
export type DashboardData = {
  projects: Project[];
  /** Every open pull request of every project. */
  pulls: PullRequest[];
  /** Per project and release workflow: the runs still going, and the last one that finished. */
  releases: ReleaseRun[];
};

/**
 * `loading`: nothing read yet. `ready`: `data` is what was last read; `refreshing` while a newer read is under way,
 * and `problem` says, in words for the user, why the last read failed (the older data stays up). `live` while
 * changes arrive as they happen; otherwise the data is only as fresh as the last read, and is read again every minute.
 */
export type DashboardState =
  | { status: "loading" }
  | {
      status: "ready";
      data: DashboardData;
      readAt: number;
      refreshing: boolean;
      problem: string | undefined;
      live: boolean;
    }
  | { status: "failed"; problem: string };

/**
 * The kinds of thing that need attention, as the relay names them: a pull request merged, changes requested on one,
 * checks failed on one, a release run finished, a release run waiting for approval.
 */
export const NOTICE_TYPES = ["merged", "changes", "checks", "release", "waiting"] as const;
export type NoticeType = (typeof NOTICE_TYPES)[number];

/**
 * Something that needs attention, as the relay tells the open pages for their desktop notifications: the same things
 * it sends to Telegram while no page is open.
 */
export type Notice = {
  type: NoticeType;
  /** What makes another notice a repeat of this one: GitHub delivering again, another check failing on a commit. */
  key: string;
  /** `owner/name`. */
  repo: string;
  /** One line, such as `Merged owner/name#7: its title`. */
  headline: string;
  /** The thing on github.com. */
  url: string;
};

/** Where the page gets its data. `web/src/github/` makes the real one; tests and the demo can make their own. */
export type Dashboard = {
  state(): DashboardState;
  /** Calls `listener` on every change of state; returns how to stop. */
  subscribe(listener: () => void): () => void;
  /** Reads everything now, and from then on keeps it fresh. Call once the user is signed in. */
  start(): void;
  /** Reads everything again now. */
  refresh(): Promise<void>;
  /** Stops keeping it fresh and forgets what was read, such as on sign-out. */
  stop(): void;
  /**
   * Says that something changed, as an event from the relay would, so that it is read again: such as after the page
   * itself merged a pull request. `kind` is a webhook's name and the rest says where, as in the relay's events.
   */
  changed(change: { kind: string; repo?: string; pull?: number; sha?: string; run?: number }): void;
  /** Calls `listener` with each notice that arrives while started; returns how to stop. Left out, none ever do. */
  onNotice?(listener: (notice: Notice) => void): () => void;
};

/**
 * What the page can do to an open pull request. Each one resolves once GitHub took it, and rejects with an `Error`
 * whose message says why not, in words for the user. On success the dashboard reads the pull request again.
 */
export type PullActions = {
  /**
   * Turns auto-merge on or off. GitHub won't wait when the base branch requires nothing; turning it on then merges at
   * once if every check passed, and `merged` says so.
   */
  setAutoMerge(pull: PullRequest, enabled: boolean): Promise<{ merged: boolean }>;
  /** Merges it now, but only the commit the page showed as its head, whose checks were seen. */
  merge(pull: PullRequest): Promise<void>;
  /** Brings its base's new commits into its branch, if its head is still the one the page showed. */
  updateBranch(pull: PullRequest): Promise<void>;
};

/** One file a pull request changes. `status` is GitHub's word: added, modified, removed, renamed and the like. */
export type ChangedFile = {
  path: string;
  /** Where a renamed or copied file was before. */
  previousPath: string | undefined;
  status: string;
  additions: number;
  deletions: number;
};

/** The files a pull request changes, as far as they were read. */
export type PullFiles = {
  files: ChangedFile[];
  /** Whether it changes more than `files` holds. */
  truncated: boolean;
};

/** Reads the files a pull request changes, rejecting with an `Error` if GitHub wouldn't say. */
export type ReadFiles = (pull: PullRequest) => Promise<PullFiles>;

/** A pull request's checks in one word: the worst that is true of them. `none` when it has no checks. */
export function summarize(checks: Check[]): "none" | "failed" | "waiting" | "running" | "passed" {
  if (checks.length === 0) {
    return "none";
  }
  const states = new Set(checks.map((check) => check.state));
  if (states.has("failed") || states.has("cancelled")) {
    return "failed";
  }
  if (states.has("waiting")) {
    return "waiting";
  }
  if (states.has("running") || states.has("queued")) {
    return "running";
  }
  return "passed";
}

/**
 * What the page can do to release runs and projects. Each one checks again on GitHub that it still applies, and
 * fails with an `Error` whose message says why in words for the user. On success the dashboard reads again what
 * changed. The real ones are in web/src/github/run_actions.ts; the demo has its own.
 */
export type RunActions = {
  /** Approves or rejects one environment a waiting run needs. */
  review(run: ReleaseRun, approval: Approval, verdict: "approved" | "rejected"): Promise<void>;
  /** Re-runs a finished run's failed and cancelled jobs, with the jobs that need them. */
  rerunFailed(run: ReleaseRun): Promise<void>;
  /** Re-runs one failed or cancelled job of a finished run, with the jobs that need it. */
  rerunJob(run: ReleaseRun, job: Job): Promise<void>;
  /** The tag the project's next release would get, once it is known that no such tag exists yet. */
  nextRelease(project: Project): Promise<string>;
  /** Publishes a release of the default branch with this tag and the notes GitHub writes for it. */
  release(project: Project, tag: string): Promise<void>;
  /** Starts the project's Promote workflow for this release tag. */
  promote(project: Project, tag: string): Promise<void>;
};

/** A release tag that Promote takes: a plain version with its `v`, such as v1.2.3. */
export const RELEASE_TAG = /^v\d+\.\d+\.\d+$/;

/** The release the project's Promote button offers: its latest, if it has a Promote workflow and such a tag. */
export function promoteTag(project: Project): string | undefined {
  const tag = project.latestRelease?.tag;
  return project.promoteWorkflow !== undefined && tag !== undefined && RELEASE_TAG.test(tag) ? tag : undefined;
}
