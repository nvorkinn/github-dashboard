import { AUTO_MERGE_OFF, DRAFT_REFUSED } from "../github/pull_actions.ts";
import type {
  Dashboard,
  DashboardData,
  DashboardState,
  Notice,
  PullActions,
  PullRequest,
  RunActions,
} from "../model.ts";
import { applyEdits, clearEdits, createDemoRunActions, forgetRun, noEdits } from "./actions.ts";
import { demoNotices, FIRST_FRAME, FRAMES, NOTHING, SCRIPTED_RUN, sampleData } from "./data.ts";

export type DemoOptions = {
  /** How long each frame of the script stays up. */
  stepMs?: number;
  /**
   * A state to hold instead of running the script, for looking at what the sample data never does: `loading`,
   * `failed`, `empty`, `problem` (the data with a failed refresh over it), or `offline` (the data while the relay's
   * events don't arrive, so the header says it is reconnecting).
   */
  show?: string | undefined;
};

const LOADING_MS = 400;
const REFRESHING_MS = 700;
/** How long a demo action takes, as a call to GitHub would. */
export const ACTION_MS = 800;
/** How long a merged pull request stays, marked merged, before it leaves the list. */
export const MERGED_MS = 1500;
/** How long the checks run after the demo updated a branch. */
export const UPDATE_CHECKS_MS = 6000;

// The demo's actions, for `demoPullActions` and `demoRunActions` to find. Kept beside the dashboard, not in its
// type, so that the rest of the page only ever sees a `Dashboard`.
const ACTIONS = new WeakMap<Dashboard, { pulls: PullActions; runs: RunActions }>();

/** The demo's pull request actions, if `dashboard` is the demo's. They change its sample data. */
export function demoPullActions(dashboard: Dashboard): PullActions | undefined {
  return ACTIONS.get(dashboard)?.pulls;
}

/** The demo's actions on release runs and projects, if `dashboard` is the demo's. They change its sample data. */
export function demoRunActions(dashboard: Dashboard): RunActions | undefined {
  return ACTIONS.get(dashboard)?.runs;
}

/**
 * The demo's dashboard: the sample data, with a script that moves one pull request's checks and one release run
 * along every few seconds and then starts over, the way webhook events move the real page. Its actions (see
 * `demoPullActions`) work on the sample data too, after a moment: auto-merge goes on and off, a merged pull request
 * leaves the list, and an updated branch runs its checks again. So do those of `demoRunActions`: an approval moves
 * its run on, a re-run puts the failed jobs back in the queue, and a release or promotion starts a run. Turning
 * auto-merge on in recipe-box is refused, as that repository doesn't allow it, and so is releasing garden-sensors,
 * so the page's way of saying an action failed can be seen.
 */
export function createDemoDashboard(options: DemoOptions = {}): Dashboard {
  const stepMs = options.stepMs ?? 3000;
  const { show } = options;
  let state: DashboardState = { status: "loading" };
  const listeners = new Set<() => void>();
  const noticeListeners = new Set<(notice: Notice) => void>();
  // How many times round the script has gone, so each round's notices are new ones.
  let round = 1;
  const timers = new Set<ReturnType<typeof setTimeout>>();
  let script: ReturnType<typeof setInterval> | undefined;
  let running = false;
  let base = 0;
  let frame = FIRST_FRAME;
  let frameAt = 0;
  // What the actions did to each pull request, applied over the sample data each time it is drawn. Undefined: gone.
  const tweaks = new Map<string, (pull: PullRequest) => PullRequest | undefined>();
  // What the actions did to release runs and projects, applied the same way.
  const edits = noEdits();

  function setState(next: DashboardState): void {
    state = next;
    for (const listener of listeners) {
      listener();
    }
  }

  /** Like setTimeout, but `stop` takes it back. */
  function later(ms: number, task: () => void): void {
    const timer = setTimeout(() => {
      timers.delete(timer);
      task();
    }, ms);
    timers.add(timer);
  }

  function tweaked(data: DashboardData): DashboardData {
    if (tweaks.size === 0) {
      return data;
    }
    const pulls = data.pulls.flatMap((pull) => {
      const tweak = tweaks.get(keyOf(pull));
      return (tweak ? tweak(pull) : pull) ?? [];
    });
    return { ...data, pulls };
  }

  function ready(refreshing: boolean, readAt: number): DashboardState {
    return {
      status: "ready",
      data: show === "empty" ? NOTHING : applyEdits(tweaked(sampleData({ base, frame, frameAt })), edits),
      readAt,
      refreshing,
      problem: show === "problem" ? "GitHub didn't answer (503). Showing what was read 5 minutes ago." : undefined,
      live: show !== "offline",
    };
  }

  /** Adds to what the actions did to a pull request, and draws it at once, as a re-read after an action would. */
  function tweak(pull: PullRequest, change: (pull: PullRequest) => PullRequest | undefined): void {
    const before = tweaks.get(keyOf(pull));
    tweaks.set(keyOf(pull), (one) => {
      const was = before ? before(one) : one;
      return was && change(was);
    });
    if (state.status === "ready") {
      setState(ready(state.refreshing, state.readAt));
    }
  }

  /** A demo action's moment of waiting for GitHub. */
  function pause(): Promise<void> {
    return new Promise((resolve) => later(ACTION_MS, resolve));
  }

  function projectOf(pull: PullRequest) {
    return state.status === "ready" ? state.data.projects.find((one) => one.repo === pull.repo) : undefined;
  }

  const actions: PullActions = {
    async setAutoMerge(pull, enabled) {
      await pause();
      if (enabled && pull.draft) {
        throw new Error(DRAFT_REFUSED);
      }
      if (enabled && projectOf(pull)?.autoMergeAllowed === false) {
        throw new Error(AUTO_MERGE_OFF);
      }
      tweak(pull, (one) => ({ ...one, autoMerge: enabled }));
      return { merged: false };
    },

    async merge(pull) {
      await pause();
      later(MERGED_MS, () => tweak(pull, () => undefined));
    },

    async updateBranch(pull) {
      await pause();
      const updatedAt = new Date().toISOString();
      // A new head commit, whose checks start over; GitHub works out whether it can be merged once they are done.
      tweak(pull, (one) => ({
        ...one,
        sha: `${one.sha}-updated`,
        updatedAt,
        mergeState: "blocked",
        checks: one.checks.map((check, index) => ({ ...check, state: index === 0 ? "running" : "queued" })),
      }));
      later(UPDATE_CHECKS_MS / 2, () =>
        tweak(pull, (one) => ({ ...one, checks: one.checks.map((check) => ({ ...check, state: "running" })) })),
      );
      later(UPDATE_CHECKS_MS, () =>
        tweak(pull, (one) => ({
          ...one,
          mergeState: "clean",
          checks: one.checks.map((check) => ({ ...check, state: "passed" })),
        })),
      );
    },
  };

  function advance(): void {
    frame = (frame + 1) % FRAMES;
    frameAt = Date.now();
    if (frame === 0) {
      // The scripted run starts over, and waits for its approval again.
      forgetRun(edits, SCRIPTED_RUN);
      round++;
    }
    setState(ready(state.status === "ready" && state.refreshing, frameAt));
    for (const notice of demoNotices(frame, round)) {
      for (const listener of [...noticeListeners]) {
        listener(notice);
      }
    }
  }

  function stop(): void {
    running = false;
    clearInterval(script);
    script = undefined;
    for (const timer of timers) {
      clearTimeout(timer);
    }
    timers.clear();
    tweaks.clear();
    clearEdits(edits);
    setState({ status: "loading" });
  }

  /** Draws the data again, with what the actions did, as a re-read after an action would. */
  function redraw(): void {
    if (state.status === "ready") {
      setState(ready(state.refreshing, state.readAt));
    }
  }

  const dashboard: Dashboard = {
    state: () => state,

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    onNotice(listener) {
      noticeListeners.add(listener);
      return () => noticeListeners.delete(listener);
    },

    start() {
      if (running) {
        return;
      }
      running = true;
      round = 1;
      base = Date.now();
      frame = FIRST_FRAME;
      frameAt = base;
      setState({ status: "loading" });
      if (show === "loading") {
        return;
      }
      // A moment of loading, as a real first read has.
      later(LOADING_MS, () => {
        if (show === "failed") {
          setState({ status: "failed", problem: "Couldn't read your projects from GitHub. Try again in a moment." });
          return;
        }
        setState(ready(false, show === "problem" ? base - 5 * 60_000 : Date.now()));
        if (!show) {
          script = setInterval(advance, stepMs);
        }
      });
    },

    refresh() {
      if (state.status !== "ready") {
        return Promise.resolve();
      }
      setState({ ...state, refreshing: true });
      return new Promise((resolve) => {
        later(REFRESHING_MS, () => {
          if (state.status === "ready") {
            setState(ready(false, show === "problem" ? state.readAt : Date.now()));
          }
          resolve();
        });
      });
    },

    // The actions change the sample data themselves, so there is nothing to read again.
    changed() {},

    stop,
  };
  ACTIONS.set(dashboard, { pulls: actions, runs: createDemoRunActions(edits, later, redraw, ACTION_MS) });
  return dashboard;
}

function keyOf(pull: PullRequest): string {
  return `${pull.repo}#${pull.number}`;
}
