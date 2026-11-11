import type { Dashboard, DashboardState, RunActions } from "../model.ts";
import { applyEdits, clearEdits, demoRunActions, forgetRun, noEdits } from "./actions.ts";
import { FIRST_FRAME, FRAMES, NOTHING, SCRIPTED_RUN, sampleData } from "./data.ts";

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

/** The demo's dashboard, with actions that work on its sample data. */
export type DemoDashboard = Dashboard & { runActions: RunActions };

export function isDemoDashboard(dashboard: Dashboard): dashboard is DemoDashboard {
  return "runActions" in dashboard;
}

const LOADING_MS = 400;
const REFRESHING_MS = 700;

/**
 * The demo's dashboard: the sample data, with a script that moves one pull request's checks and one release run
 * along every few seconds and then starts over, the way webhook events move the real page. Its actions change the
 * sample data as the real ones change GitHub, until the demo stops.
 */
export function createDemoDashboard(options: DemoOptions = {}): DemoDashboard {
  const stepMs = options.stepMs ?? 3000;
  const { show } = options;
  let state: DashboardState = { status: "loading" };
  const listeners = new Set<() => void>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  let script: ReturnType<typeof setInterval> | undefined;
  let running = false;
  let base = 0;
  let frame = FIRST_FRAME;
  let frameAt = 0;
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

  function ready(refreshing: boolean, readAt: number): DashboardState {
    return {
      status: "ready",
      data: show === "empty" ? NOTHING : applyEdits(sampleData({ base, frame, frameAt }), edits),
      readAt,
      refreshing,
      problem: show === "problem" ? "GitHub didn't answer (503). Showing what was read 5 minutes ago." : undefined,
      live: show !== "offline",
    };
  }

  function advance(): void {
    frame = (frame + 1) % FRAMES;
    frameAt = Date.now();
    if (frame === 0) {
      // The scripted run starts over, and waits for its approval again.
      forgetRun(edits, SCRIPTED_RUN);
    }
    setState(ready(state.status === "ready" && state.refreshing, frameAt));
  }

  function stop(): void {
    running = false;
    clearInterval(script);
    script = undefined;
    for (const timer of timers) {
      clearTimeout(timer);
    }
    timers.clear();
    clearEdits(edits);
    setState({ status: "loading" });
  }

  /** Draws the data again, with what the actions did. */
  function changed(): void {
    if (state.status === "ready") {
      setState(ready(state.refreshing, show === "problem" ? state.readAt : Date.now()));
    }
  }

  return {
    state: () => state,

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    start() {
      if (running) {
        return;
      }
      running = true;
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

    stop,

    changed,

    runActions: demoRunActions(edits, later, changed),
  };
}
