import type { ReleasesSnapshot } from "../../../shared/runs.ts";
import type { Auth } from "../auth.ts";
import type { Approval, Dashboard, DashboardData, DashboardState, Notice, PullRequest, ReleaseRun } from "../model.ts";
import { createApi, GitHubError } from "./api.ts";
import { type Change, type Connect, createEvents } from "./events.ts";
import { readEverything, type Shape } from "./graphql.ts";
import { type Plan, pendingApprovals, planFor, type ReadResult, readChanged } from "./read.ts";
import { withRun } from "./releases.ts";

// How often everything is read again while the relay's events don't arrive: as often as before there were any.
export const REFRESH_MS = 60_000;
// While they do arrive, reading everything is only a net under them: for an event that got lost on the way.
export const LIVE_REFRESH_MS = 5 * 60_000;
// Changes come in bursts, and a burst is read once: this long after its last change, but no later than
// CHANGE_MAX_WAIT_MS after its first, so that changes that keep coming still show.
export const CHANGE_WAIT_MS = 1000;
export const CHANGE_MAX_WAIT_MS = 5000;
// The relay's hello asks for everything to be read, except when it just was: on start and on coming back to the
// page, the read and the connection begin together.
const JUST_READ_MS = 2000;
// GitHub works out whether a pull request can be merged only when asked, and answers "unknown" until it has. Such a
// pull request is asked about again this long after, up to this many times in a row.
export const SETTLE_MS = 2000;
export const SETTLE_TRIES = 3;

export type DashboardOptions = {
  /** How long after one read of everything the next one starts, while the relay's events don't arrive. */
  refreshMs?: number;
  /** How many requests to api.github.com may be under way at once. */
  parallel?: number;
  /** Opens the relay's stream of events, in place of the browser's `EventSource`. */
  connect?: Connect;
  /** The projects (`owner/name`) the user has hidden, as they are now: only their rows are read. */
  hidden?: () => ReadonlySet<string>;
  /**
   * Keeps which projects a read asks about between visits, so that the first read of the next visit is one round of
   * requests too. Only names of projects; without it, a visit's first read takes two.
   */
  shape?: { load(): Shape | undefined; save(shape: Shape): void };
};

/**
 * The dashboard's data. The projects and their pull requests are read from api.github.com as the signed-in user:
 * everything at the start and then every so often, through GraphQL (graphql.ts); in between, the relay's events say
 * what changed, and only that is read again (read.ts): a pull request with one GraphQL query of its own.
 *
 * The release runs aren't read at all: the relay keeps them and tells the page, all of them on connecting and each
 * one whole as it changes (releases.ts). The page shows what the relay last said, of the projects it shows. The one
 * thing it asks GitHub about a run is whether the signed-in user may approve what the run waits for, which only that
 * user's token can say.
 */
export function createDashboard(auth: Auth, options: DashboardOptions = {}): Dashboard {
  const refreshMs = options.refreshMs ?? REFRESH_MS;
  let state: DashboardState = { status: "loading" };
  let started = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  // The read under way: of everything, or of what some changes named.
  let reading: { all: boolean; done: Promise<void> } | undefined;
  let abort: AbortController | undefined;
  // After a rate limit: when GitHub will answer again.
  let notBefore = 0;
  // Set while only reading everything will do: nothing was read yet, or a read failed and its changes with it.
  let missed = true;
  let allReadAt = Number.NEGATIVE_INFINITY;
  // The changes not read yet, and when the first of them came.
  let changes: Change[] = [];
  let changesSince = 0;
  let changeTimer: ReturnType<typeof setTimeout> | undefined;
  // How often each pull request whose merge state is unknown was asked about again.
  const unsettled = new Map<string, number>();
  // Which projects a read of everything asks about: what the last one found, or what the last visit kept.
  let shape: Shape | undefined;
  // The release runs and each project's Promote workflow, as the relay last told them.
  let relayed: Pick<ReleasesSnapshot, "projects" | "runs"> = { projects: {}, runs: [] };
  // Per run that waits: what its approvals were asked for, and the signed-in user's own answer once it is in.
  const approvals = new Map<string, { asked: string; found: Approval[] | undefined }>();
  const hiddenProjects = (): ReadonlySet<string> => options.hidden?.() ?? new Set();
  let settleTimer: ReturnType<typeof setTimeout> | undefined;
  const listeners = new Set<() => void>();
  const noticeListeners = new Set<(notice: Notice) => void>();
  const events = createEvents({ connect: options.connect, onLive, onChange, onNotice, onReleases, onRun });

  function setState(next: DashboardState): void {
    state = next;
    for (const listener of listeners) {
      listener();
    }
  }

  // All the timing of re-reads is in the functions from here to `begin`.

  /** Reads everything in `delay`, unless the page is stopped or hidden. Never sooner than a rate limit allows. */
  function schedule(delay: number): void {
    clearTimeout(timer);
    if (started && !hidden()) {
      timer = setTimeout(() => void readAll(), Math.max(delay, notBefore - Date.now(), 0));
    }
  }

  /** How long after a read of everything the next one starts. Soon after one that didn't get all of it. */
  function fallbackMs(): number {
    return events.live() && !troubled() ? LIVE_REFRESH_MS : refreshMs;
  }

  function troubled(): boolean {
    return state.status !== "ready" || state.problem !== undefined;
  }

  function onVisibility(): void {
    // Nobody is looking at a hidden page; coming back to it, what it shows may be old.
    schedule(0);
  }

  function onLive(live: boolean): void {
    if (!started) {
      return;
    }
    if (state.status === "ready" && state.live !== live) {
      setState({ ...state, live });
    }
    if (!live) {
      schedule(refreshMs);
      return;
    }
    // What changed while not connected never arrives, so everything is read: now, or at its slower pace if it
    // just was.
    const fresh = reading?.all || Date.now() - allReadAt < JUST_READ_MS;
    schedule(fresh ? fallbackMs() : 0);
  }

  function onNotice(notice: Notice): void {
    if (!started) {
      return;
    }
    for (const listener of [...noticeListeners]) {
      listener(notice);
    }
  }

  /** `data` with the release runs and Promote workflows the relay last told, of the projects that are shown. */
  function withReleases(data: DashboardData): DashboardData {
    const hiddenNow = hiddenProjects();
    const shown = new Set(data.projects.map((one) => one.repo).filter((repo) => !hiddenNow.has(repo)));
    return {
      projects: data.projects.map((one) => {
        const promoteWorkflow = shown.has(one.repo) ? relayed.projects[one.repo]?.promoteWorkflow : undefined;
        return one.promoteWorkflow === promoteWorkflow ? one : { ...one, promoteWorkflow };
      }),
      pulls: data.pulls,
      releases: relayed.runs
        .filter((run) => shown.has(run.repo))
        .map((run) => {
          const mine = run.state === "waiting" ? approvals.get(runKey(run))?.found : undefined;
          return mine ? { ...run, approvals: mine } : run;
        }),
    };
  }

  /** Shows what the relay last told, and asks about the approvals of the runs that wait. */
  function showReleases(): void {
    if (state.status === "ready") {
      setState({ ...state, data: withReleases(state.data) });
      askApprovals(state.data.releases);
    }
  }

  function onReleases(snapshot: ReleasesSnapshot): void {
    if (started) {
      relayed = snapshot;
      showReleases();
    }
  }

  function onRun(run: ReleaseRun): void {
    if (started) {
      relayed = { projects: relayed.projects, runs: withRun(relayed.runs, run) };
      showReleases();
    }
  }

  /**
   * Asks GitHub, as the signed-in user, which of the environments each waiting run waits for that user may approve:
   * once per run and set of waiting jobs, and again when a review of it is told.
   */
  function askApprovals(runs: ReleaseRun[]): void {
    const waiting = new Map(runs.filter((run) => run.state === "waiting").map((run) => [runKey(run), run]));
    for (const key of approvals.keys()) {
      if (!waiting.has(key)) {
        approvals.delete(key);
      }
    }
    for (const [key, run] of waiting) {
      const jobs = run.jobs.filter((one) => one.state === "waiting").map((one) => one.id);
      const asked = `${jobs.join(",")}|${run.approvals.map((one) => one.environmentId).join(",")}`;
      const before = approvals.get(key);
      if (before?.asked === asked) {
        continue;
      }
      approvals.set(key, { asked, found: before?.found });
      void pendingApprovals(createApi(auth), run.repo, run.id)
        .catch(() => undefined)
        .then((found) => {
          // Asked again meanwhile, or no longer wanted: that answer counts, not this one.
          if (started && approvals.get(key)?.asked === asked) {
            approvals.set(key, { asked, found });
            if (state.status === "ready") {
              setState({ ...state, data: withReleases(state.data) });
            }
          }
        });
    }
  }

  function onChange(change: Change): void {
    if (!started) {
      return;
    }
    if (change.kind === "deployment_review" && change.repo !== undefined && change.run !== undefined) {
      // Someone approved or rejected: whether the rest is the user's to approve is asked again.
      approvals.delete(runKey({ repo: change.repo, id: change.run }));
      showReleases();
    }
    if (changes.length === 0) {
      changesSince = Date.now();
    }
    changes.push(change);
    clearTimeout(changeTimer);
    const wait = Math.min(CHANGE_WAIT_MS, changesSince + CHANGE_MAX_WAIT_MS - Date.now());
    changeTimer = setTimeout(
      () => {
        changeTimer = undefined;
        readChanges();
      },
      Math.max(wait, 0),
    );
  }

  /** Reads what the changes so far name. During a read they wait, and that read starts this at its end. */
  function readChanges(): void {
    if (!started || reading || changes.length === 0) {
      return;
    }
    const plan =
      missed || hidden() || state.status !== "ready" ? "everything" : planFor(changes, state.data, hiddenProjects());
    changes = [];
    if (plan === "everything") {
      missed = true;
      if (hidden() || Date.now() < notBefore) {
        // Not now: when the page is shown again, or the rate limit ends.
        schedule(0);
      } else {
        void readAll();
      }
    } else if (plan.size > 0) {
      void begin(plan);
    }
  }

  /** Reads everything. Callers that arrive during such a read share it. */
  function readAll(): Promise<void> {
    if (!reading) {
      return begin("everything");
    }
    if (reading.all) {
      return reading.done;
    }
    // Some changes are being read: everything is, once that is done.
    return reading.done.then(() => (started ? readAll() : undefined));
  }

  function begin(plan: Plan): Promise<void> {
    const all = plan === "everything";
    if (all) {
      // Whatever the changes so far named is read with everything else.
      changes = [];
      clearTimeout(changeTimer);
      changeTimer = undefined;
    }
    const wasTroubled = troubled();
    const done = readOnce(plan).finally(() => {
      // A stop() in the meantime has already cleared this, and a start() after it may have begun another.
      if (reading?.done !== done) {
        return;
      }
      reading = undefined;
      if (all) {
        allReadAt = Date.now();
      }
      // A read of changes leaves the next read of everything where it was, unless it is what ran into trouble.
      if (all || (troubled() && !wasTroubled)) {
        schedule(fallbackMs());
      }
      if (changes.length > 0 && changeTimer === undefined) {
        readChanges();
      }
    });
    reading = { all, done };
    return done;
  }

  async function readOnce(plan: Plan): Promise<void> {
    const controller = new AbortController();
    abort = controller;
    const previous = state.status === "ready" ? state.data : undefined;
    const all = plan === "everything" || !previous;
    // A read of changes is small and frequent, and the page doesn't flicker for each.
    if (state.status === "ready" && all) {
      setState({ ...state, refreshing: true });
    }
    try {
      const result =
        plan === "everything" || !previous
          ? await readAllOf(controller.signal, previous)
          : await readChanged(
              createApi(auth, {
                signal: controller.signal,
                ...(options.parallel ? { parallel: options.parallel } : {}),
              }),
              plan,
              previous,
            );
      // Stopped while reading: this is no longer wanted, and may be another user's by now.
      if (controller.signal.aborted) {
        return;
      }
      notBefore = 0;
      if (all) {
        missed = false;
      }
      setState({
        status: "ready",
        data: withReleases(result.data),
        readAt: Date.now(),
        refreshing: false,
        // What a read of everything couldn't read is still unread after a read of something else.
        problem: result.problem ?? (!all && state.status === "ready" ? state.problem : undefined),
        live: events.live(),
      });
      settle(result.data);
      if (state.status === "ready") {
        askApprovals(state.data.releases);
      }
    } catch (error) {
      if (controller.signal.aborted) {
        return;
      }
      notBefore = error instanceof GitHubError ? (error.retryAt ?? 0) : 0;
      missed = true;
      const problem = describe(error);
      setState(state.status === "ready" ? { ...state, refreshing: false, problem } : { status: "failed", problem });
    }
  }

  async function readAllOf(signal: AbortSignal, previous: DashboardData | undefined): Promise<ReadResult> {
    const result = await readEverything(auth, {
      previous,
      hidden: hiddenProjects(),
      shape: shape ?? load(),
      signal,
      parallel: options.parallel,
    });
    if (!signal.aborted) {
      shape = result.shape;
      try {
        options.shape?.save(result.shape);
      } catch {
        // Not kept, then: the next visit's first read takes a few requests.
      }
    }
    return result;
  }

  function load(): Shape | undefined {
    try {
      return options.shape?.load();
    } catch {
      return undefined;
    }
  }

  /** Asks again, in a moment, about the pull requests whose merge state GitHub hadn't worked out yet. */
  function settle(data: DashboardData): void {
    const unknown = data.pulls.filter((pull) => pull.mergeState === "unknown");
    const keys = new Set(unknown.map(keyOf));
    for (const key of unsettled.keys()) {
      if (!keys.has(key)) {
        unsettled.delete(key);
      }
    }
    const again = unknown.filter((pull) => (unsettled.get(keyOf(pull)) ?? 0) < SETTLE_TRIES);
    clearTimeout(settleTimer);
    if (again.length > 0) {
      settleTimer = setTimeout(() => {
        for (const pull of again) {
          unsettled.set(keyOf(pull), (unsettled.get(keyOf(pull)) ?? 0) + 1);
          onChange({ kind: "pull_request", repo: pull.repo, pull: pull.number });
        }
      }, SETTLE_MS);
    }
  }

  return {
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
      if (started) {
        return;
      }
      started = true;
      if (typeof document !== "undefined") {
        document.addEventListener("visibilitychange", onVisibility);
      }
      void readAll();
      events.start();
    },

    refresh() {
      // Nothing to read for a page that is stopped, such as after sign-out.
      return started ? readAll() : Promise.resolve();
    },

    changed(change) {
      // Read like the relay's events: with whatever else changed in the same moment.
      onChange(change);
    },

    stop() {
      started = false;
      events.stop();
      clearTimeout(timer);
      clearTimeout(changeTimer);
      clearTimeout(settleTimer);
      changeTimer = undefined;
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", onVisibility);
      }
      abort?.abort();
      reading = undefined;
      notBefore = 0;
      missed = true;
      allReadAt = Number.NEGATIVE_INFINITY;
      changes = [];
      unsettled.clear();
      shape = undefined;
      relayed = { projects: {}, runs: [] };
      approvals.clear();
      if (state.status !== "loading") {
        setState({ status: "loading" });
      }
    },
  };
}

function hidden(): boolean {
  return typeof document !== "undefined" && document.hidden;
}

function runKey(run: { repo: string; id: number }): string {
  return `${run.repo}#${run.id}`;
}

function keyOf(pull: PullRequest): string {
  return `${pull.repo}#${pull.number}`;
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
