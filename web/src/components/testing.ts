import { vi } from "vitest";
import type {
  Approval,
  Dashboard,
  DashboardData,
  DashboardState,
  Job,
  Notice,
  Project,
  PullRequest,
  ReleaseRun,
  RunActions,
} from "../model.ts";

/** Run actions that do nothing but record what they were asked. */
export function fakeRunActions() {
  return {
    review: vi.fn(async (_run: ReleaseRun, _approval: Approval, _verdict: "approved" | "rejected") => {}),
    rerunFailed: vi.fn(async (_run: ReleaseRun) => {}),
    rerunJob: vi.fn(async (_run: ReleaseRun, _job: Job) => {}),
    nextRelease: vi.fn(async (_project: Project) => "v1.3.0"),
    release: vi.fn(async (_project: Project, _tag: string) => {}),
    promote: vi.fn(async (_project: Project, _tag: string) => {}),
  } satisfies RunActions;
}

/** The moment the tests' data is dated from. */
export const NOW = Date.parse("2026-03-01T12:00:00Z");

export const before = (ms: number) => new Date(NOW - ms).toISOString();

export function pull(fields: Partial<PullRequest> = {}): PullRequest {
  return {
    repo: "octocat/weather-station",
    number: 1,
    title: "A change",
    url: "https://github.com/octocat/weather-station/pull/1",
    author: "monalisa",
    authorAvatarUrl: "https://avatars.githubusercontent.com/u/1",
    draft: false,
    head: "monalisa/change",
    base: "main",
    sha: "abc1234",
    createdAt: before(3_600_000),
    updatedAt: before(60_000),
    mergeState: "clean",
    autoMerge: false,
    checks: [],
    nodeId: "PR_kwDOAbc",
    ...fields,
  };
}

export function run(fields: Partial<ReleaseRun> = {}): ReleaseRun {
  return {
    repo: "octocat/weather-station",
    id: 1,
    workflow: "Release",
    title: "v1.0.0",
    url: "https://github.com/octocat/weather-station/actions/runs/1",
    state: "passed",
    actor: "octocat",
    startedAt: before(360_000),
    finishedAt: before(60_000),
    jobs: [],
    approvals: [],
    ...fields,
  };
}

export function project(fields: Partial<Project> = {}): Project {
  return {
    repo: "octocat/weather-station",
    name: "weather-station",
    url: "https://github.com/octocat/weather-station",
    private: false,
    pushedAt: undefined,
    latestRelease: undefined,
    defaultBranch: "main",
    unreleased: undefined,
    mergeMethod: "merge",
    autoMergeAllowed: true,
    promoteWorkflow: undefined,
    ...fields,
  };
}

export function ready(
  data: Partial<DashboardData> = {},
  rest: { refreshing?: boolean; problem?: string; live?: boolean } = {},
) {
  return {
    status: "ready",
    data: { projects: [], pulls: [], releases: [], ...data },
    readAt: NOW - 12_000,
    refreshing: rest.refreshing ?? false,
    problem: rest.problem,
    live: rest.live ?? true,
  } satisfies DashboardState;
}

/** A dashboard a test steers by hand: `set` changes its state, and the calls made to it are counted. */
export function fakeDashboard(initial: DashboardState = { status: "loading" }) {
  let state = initial;
  const listeners = new Set<() => void>();
  const noticeListeners = new Set<(notice: Notice) => void>();
  return {
    state: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    onNotice(listener: (notice: Notice) => void) {
      noticeListeners.add(listener);
      return () => noticeListeners.delete(listener);
    },
    /** Hands `notice` to whoever listens, as one from the relay. */
    notice(notice: Notice) {
      for (const listener of noticeListeners) {
        listener(notice);
      }
    },
    start: vi.fn(),
    refresh: vi.fn(async () => {}),
    stop: vi.fn(),
    changed: vi.fn(),
    set(next: DashboardState) {
      state = next;
      for (const listener of listeners) {
        listener();
      }
    },
  } satisfies Dashboard & { set(next: DashboardState): void; notice(notice: Notice): void };
}
