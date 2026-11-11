import type { Dashboard, DashboardState } from "../model.ts";
import { FIRST_FRAME, FRAMES, NOTHING, sampleData } from "./data.ts";

export type DemoOptions = {
  /** How long each frame of the script stays up. */
  stepMs?: number;
  /**
   * A state to hold instead of running the script, for looking at what the sample data never does: `loading`,
   * `failed`, `empty`, or `problem` (the data with a failed refresh over it).
   */
  show?: string | undefined;
};

const LOADING_MS = 400;
const REFRESHING_MS = 700;

/**
 * The demo's dashboard: the sample data, with a script that moves one pull request's checks and one release run
 * along every few seconds and then starts over, the way webhook events move the real page.
 */
export function createDemoDashboard(options: DemoOptions = {}): Dashboard {
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
      data: show === "empty" ? NOTHING : sampleData({ base, frame, frameAt }),
      readAt,
      refreshing,
      problem: show === "problem" ? "GitHub didn't answer (503). Showing what was read 5 minutes ago." : undefined,
    };
  }

  function advance(): void {
    frame = (frame + 1) % FRAMES;
    frameAt = Date.now();
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
    setState({ status: "loading" });
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
  };
}
