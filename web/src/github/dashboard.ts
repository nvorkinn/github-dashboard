import type { Auth } from "../auth.ts";
import type { Dashboard, DashboardState } from "../model.ts";
import { createApi, GitHubError } from "./api.ts";
import { readDashboard } from "./read.ts";

// How often everything is read again while the page is visible. Polling is a stopgap: webhook events passed on by
// the relay will say when to read instead.
export const REFRESH_MS = 60_000;

export type DashboardOptions = {
  /** How long after one read the next one starts. */
  refreshMs?: number;
  /** How many requests to api.github.com may be under way at once. */
  parallel?: number;
};

/** The dashboard's data, read from api.github.com as the signed-in user. */
export function createDashboard(auth: Auth, options: DashboardOptions = {}): Dashboard {
  const refreshMs = options.refreshMs ?? REFRESH_MS;
  let state: DashboardState = { status: "loading" };
  let started = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let reading: Promise<void> | undefined;
  let abort: AbortController | undefined;
  // After a rate limit: when GitHub will answer again.
  let notBefore = 0;
  const listeners = new Set<() => void>();

  function setState(next: DashboardState): void {
    state = next;
    for (const listener of listeners) {
      listener();
    }
  }

  // All the timing of re-reads is in these three functions.

  /** Reads again in `delay`, unless the page is stopped or hidden. Never sooner than a rate limit allows. */
  function schedule(delay: number): void {
    clearTimeout(timer);
    if (started && !hidden()) {
      timer = setTimeout(() => void read(), Math.max(delay, notBefore - Date.now(), 0));
    }
  }

  function onVisibility(): void {
    // Nobody is looking at a hidden page; coming back to it, what it shows may be old.
    schedule(0);
  }

  /** Reads everything. Callers that arrive during a read share it. */
  function read(): Promise<void> {
    if (!reading) {
      const mine = readOnce().finally(() => {
        // A stop() in the meantime has already cleared this, and a start() after it may have begun another.
        if (reading === mine) {
          reading = undefined;
          schedule(refreshMs);
        }
      });
      reading = mine;
    }
    return reading;
  }

  async function readOnce(): Promise<void> {
    const controller = new AbortController();
    abort = controller;
    const previous = state.status === "ready" ? state.data : undefined;
    if (state.status === "ready") {
      setState({ ...state, refreshing: true });
    }
    try {
      const api = createApi(auth, {
        signal: controller.signal,
        ...(options.parallel ? { parallel: options.parallel } : {}),
      });
      const result = await readDashboard(api, previous);
      // Stopped while reading: this is no longer wanted, and may be another user's by now.
      if (controller.signal.aborted) {
        return;
      }
      notBefore = 0;
      setState({ status: "ready", data: result.data, readAt: Date.now(), refreshing: false, problem: result.problem });
    } catch (error) {
      if (controller.signal.aborted) {
        return;
      }
      notBefore = error instanceof GitHubError ? (error.retryAt ?? 0) : 0;
      const problem = describe(error);
      setState(state.status === "ready" ? { ...state, refreshing: false, problem } : { status: "failed", problem });
    }
  }

  return {
    state: () => state,

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    start() {
      if (started) {
        return;
      }
      started = true;
      if (typeof document !== "undefined") {
        document.addEventListener("visibilitychange", onVisibility);
      }
      void read();
    },

    refresh() {
      // Nothing to read for a page that is stopped, such as after sign-out.
      return started ? read() : Promise.resolve();
    },

    stop() {
      started = false;
      clearTimeout(timer);
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", onVisibility);
      }
      abort?.abort();
      reading = undefined;
      notBefore = 0;
      if (state.status !== "loading") {
        setState({ status: "loading" });
      }
    },
  };
}

function hidden(): boolean {
  return typeof document !== "undefined" && document.hidden;
}

/** Why a read failed, in words for the user. */
export function describe(error: unknown): string {
  if (!(error instanceof GitHubError)) {
    return "GitHub couldn't be reached.";
  }
  if (error.retryAt !== undefined) {
    const at = new Date(error.retryAt);
    const time = `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
    return `GitHub's rate limit is used up. Trying again at ${time}.`;
  }
  if (error.status === 401) {
    return "GitHub no longer accepts the sign-in. Sign in again.";
  }
  if (error.status >= 500) {
    return `GitHub is having trouble (${error.status}).`;
  }
  return `GitHub refused the read (${error.status}).`;
}
