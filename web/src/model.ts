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

/** One run of a release workflow (a workflow whose name says release, deploy or promote). */
export type ReleaseRun = {
  repo: string;
  id: number;
  /** The workflow's name, such as "Release". */
  workflow: string;
  /** What the run is of: its display title on GitHub, such as the tag or the commit's subject. */
  title: string;
  url: string;
  state: CheckState;
  /** Who started it. */
  actor: string | undefined;
  startedAt: string;
  /** Unset while it runs. */
  finishedAt: string | undefined;
  jobs: Job[];
};

export type Project = {
  /** `owner/name`. */
  repo: string;
  /** Just the name. */
  name: string;
  description: string | undefined;
  url: string;
  defaultBranch: string;
  private: boolean;
  pushedAt: string | undefined;
  /** The newest published release, if there is one. */
  latestRelease: { tag: string; url: string; publishedAt: string } | undefined;
};

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
};

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
