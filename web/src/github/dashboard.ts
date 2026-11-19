import type { PendingSnapshot } from "../../../shared/pending.ts";
import type { MergeState, MergeUpdate } from "../../../shared/pulls.ts";
import type { ReleasesSnapshot } from "../../../shared/runs.ts";
import type { Auth } from "../auth.ts";
import type { Approval, Dashboard, DashboardData, DashboardState, Notice, PullRequest, ReleaseRun } from "../model.ts";
import { labelled, record, sinceLoad } from "../telemetry.ts";
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
  // When each change came and what from, for the telemetry: how long it took to show (see recordRead).
  const told = new WeakMap<Change, { at: number; source: ChangeSource }>();
  // How often each pull request whose merge state is unknown was asked about again.
  const unsettled = new Map<string, number>();
  // Whether the relay reads GitHub as the app, and so tells merge states itself after a push (see onMerge).
  let mergeStatesFromRelay = false;
  // The merge states the relay told, per pull request (`owner/name#number`), with the head and base they are for and
  // when they came: one that came during a read is newer than what the read found.
  const merges = new Map<string, { sha: string; base: string; mergeState: MergeState; at: number }>();
  // The pull requests as the relay last told their merge state. The page doesn't ask GitHub again about one of these
  // that is unknown: the relay tried, and the next push or read of everything asks again.
  const fromRelay = new WeakSet<PullRequest>();
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
  // The pending releases, as the relay last told them; undefined until it does, or where it can't keep them.
  let pending: PendingSnapshot | undefined;
  const events = createEvents({
    connect: options.connect,
    onLive,
    onChange,
    onNotice,
    onReleases,
    onRun,
    onMerge,
    onPending,
  });

  function setState(next: DashboardState): void {
    state = next;
    for (const listener of listeners) {
      listener();
    }
  }

  // All the timing of re-reads is in the functions from here to `begin`.

  /** Reads everything in `delay`, unless the page is stopped or hidden. Never sooner than a rate limit allows. */
  function schedule(delay: number, reason: Reason): void {
    clearTimeout(timer);
    if (started && !hidden()) {
      timer = setTimeout(() => void readAll(reason), Math.max(delay, notBefore - Date.now(), 0));
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
    schedule(0, "visible");
  }

  function onLive(live: boolean): void {
    if (!started) {
      return;
    }
    if (state.status === "ready" && state.live !== live) {
      setState({ ...state, live });
    }
    record("stream", { live });
    if (!live) {
      schedule(refreshMs, "fallback");
      return;
    }
    // What changed while not connected never arrives, so everything is read: now, or at its slower pace if it
    // just was.
    const fresh = reading?.all || Date.now() - allReadAt < JUST_READ_MS;
    schedule(fresh ? fallbackMs() : 0, fresh ? "fallback" : "reconnect");
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
      ...(pending?.configured ? { pending: pending.pending } : {}),
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
      mergeStatesFromRelay = snapshot.configured;
      relayed = snapshot;
      showReleases();
    }
  }

  function onPending(snapshot: PendingSnapshot): void {
    if (started) {
      pending = snapshot;
      if (state.status === "ready") {
        setState({ ...state, data: withReleases(state.data) });
      }
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
      void pendingApprovals(createApi(labelled(auth, "approvals")), run.repo, run.id)
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

  /** Shows the merge states the relay worked out after a push, of the pull requests still at the head they are for. */
  function onMerge(update: MergeUpdate): void {
    if (!started) {
      return;
    }
    const at = Date.now();
    for (const pull of update.pulls) {
      merges.set(`${update.repo}#${pull.number}`, {
        sha: pull.sha,
        base: update.base,
        mergeState: pull.mergeState,
        at,
      });
    }
    if (state.status === "ready") {
      const data = withMerges(state.data, at);
      if (data !== state.data) {
        setState({ ...state, data });
      }
    }
  }

  /**
   * `data` with the merge states the relay told since `since` (`Date.now()`), each where the pull request still has
   * the head and base it was told for. With `prune`, what the relay told before is forgotten: `data` is newer.
   */
  function withMerges(data: DashboardData, since: number, prune = false): DashboardData {
    for (const [key, told] of merges) {
      if (prune && told.at < since) {
        merges.delete(key);
      }
    }
    let changed = false;
    const pulls = data.pulls.map((pull) => {
      const told = merges.get(keyOf(pull));
      if (!told || told.at < since || told.sha !== pull.sha || told.base !== pull.base) {
        return pull;
      }
      const next = told.mergeState === pull.mergeState ? pull : { ...pull, mergeState: told.mergeState };
      fromRelay.add(next);
      changed ||= next !== pull;
      return next;
    });
    return changed ? { ...data, pulls } : data;
  }

  function onChange(change: Change, source: ChangeSource = "event"): void {
    if (!started) {
      return;
    }
    told.set(change, { at: Date.now(), source });
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
      missed || hidden() || state.status !== "ready"
        ? "everything"
        : planFor(changes, state.data, hiddenProjects(), { mergeStatesFromRelay });
    const batch = changes;
    changes = [];
    if (plan === "everything") {
      missed = true;
      if (hidden() || Date.now() < notBefore) {
        // Not now: when the page is shown again, or the rate limit ends.
        schedule(0, "changes");
      } else {
        void readAll("changes");
      }
    } else if (plan.size > 0) {
      void begin(plan, reasonOf(batch), batch);
    }
  }

  /** Reads everything. Callers that arrive during such a read share it. */
  function readAll(reason: Reason): Promise<void> {
    if (!reading) {
      return begin("everything", reason);
    }
    if (reading.all) {
      return reading.done;
    }
    // Some changes are being read: everything is, once that is done.
    return reading.done.then(() => (started ? readAll(reason) : undefined));
  }

  /** Why the page asks again: what the changes in `batch` came from, the relay's events before anything else. */
  function reasonOf(batch: Change[]): Reason {
    const sources = new Set(batch.map((change) => told.get(change)?.source ?? "event"));
    return sources.has("event") ? "event" : sources.has("action") ? "action" : "settle";
  }

  function begin(plan: Plan, reason: Reason, batch: Change[] = []): Promise<void> {
    const all = plan === "everything";
    if (all) {
      // Whatever the changes so far named is read with everything else.
      changes = [];
      clearTimeout(changeTimer);
      changeTimer = undefined;
    }
    const wasTroubled = troubled();
    const done = readOnce(plan, reason, batch).finally(() => {
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
        schedule(fallbackMs(), "fallback");
      }
      if (changes.length > 0 && changeTimer === undefined) {
        readChanges();
      }
    });
    reading = { all, done };
    return done;
  }

  async function readOnce(plan: Plan, reason: Reason, batch: Change[]): Promise<void> {
    const controller = new AbortController();
    abort = controller;
    const startedAt = Date.now();
    const firstData = state.status !== "ready";
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
              createApi(labelled(auth, "read.changes"), {
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
        // What the relay told while this was read is newer than what it found.
        data: withReleases(withMerges(result.data, startedAt, true)),
        readAt: Date.now(),
        refreshing: false,
        // What a read of everything couldn't read is still unread after a read of something else.
        problem: result.problem ?? (!all && state.status === "ready" ? state.problem : undefined),
        live: events.live(),
      });
      if (state.status === "ready") {
        recordRead({
          reason,
          all,
          plan,
          startedAt,
          previous,
          data: state.data,
          problem: result.problem,
          firstData,
          batch,
        });
      }
      if (state.status === "ready") {
        settle(state.data);
      }
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
      record("read", {
        reason,
        all,
        ms: Date.now() - startedAt,
        failed: error instanceof GitHubError ? error.status : 0,
      });
      setState(state.status === "ready" ? { ...state, refreshing: false, problem } : { status: "failed", problem });
    }
  }

  async function readAllOf(signal: AbortSignal, previous: DashboardData | undefined): Promise<ReadResult> {
    const result = await readEverything(labelled(auth, "read.everything"), {
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

  /**
   * Asks again, in a moment, about the pull requests whose merge state GitHub hadn't worked out yet, but those the
   * relay last told of: it asked often enough already.
   */
  function settle(data: DashboardData): void {
    const unknown = data.pulls.filter((pull) => pull.mergeState === "unknown" && !fromRelay.has(pull));
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
          onChange({ kind: "pull_request", repo: pull.repo, pull: pull.number }, "settle");
        }
      }, SETTLE_MS);
    }
  }

  /**
   * Records a read for the telemetry: why it ran, how long it took, and what it found that the page didn't already
   * show; and of each change it read for that came with a webhook's delivery id, how long the change took to show.
   */
  function recordRead(read: {
    reason: Reason;
    all: boolean;
    plan: Plan;
    startedAt: number;
    previous: DashboardData | undefined;
    data: DashboardData;
    problem: string | undefined;
    firstData: boolean;
    batch: Change[];
  }): void {
    const now = Date.now();
    record("read", {
      reason: read.reason,
      all: read.all,
      repos: read.plan === "everything" ? undefined : read.plan.size,
      ms: now - read.startedAt,
      ...differences(read.previous, read.data),
      problem: read.problem !== undefined || undefined,
      sinceLoadMs: read.firstData ? sinceLoad() : undefined,
    });
    for (const change of read.batch) {
      const came = told.get(change);
      if (change.delivery !== undefined && came) {
        record("change_shown", {
          delivery: change.delivery,
          // Not `kind`, which is the event's own.
          change: change.kind,
          waitedMs: read.startedAt - came.at,
          totalMs: now - came.at,
        });
      }
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
      void readAll("start");
      events.start();
    },

    refresh() {
      // Nothing to read for a page that is stopped, such as after sign-out.
      return started ? readAll("refresh") : Promise.resolve();
    },

    changed(change) {
      // Read like the relay's events: with whatever else changed in the same moment.
      onChange(change, "action");
    },

    pendingChanged: onPending,

    stop() {
      started = false;
      pending = undefined;
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

/** Why a read ran, for the telemetry. */
type Reason = "start" | "refresh" | "visible" | "fallback" | "reconnect" | "changes" | "event" | "action" | "settle";
/** Where a change came from: the relay's events, the page's own buttons, or asking again about a merge state. */
type ChangeSource = "event" | "action" | "settle";

/**
 * How what a read found differs from what the page showed before, in counts: projects and pull requests added,
 * removed or changed. All zero is a read that found nothing new.
 */
export function differences(
  before: DashboardData | undefined,
  after: DashboardData,
): Record<"projectsChanged" | "pullsAdded" | "pullsRemoved" | "pullsChanged", number> {
  const was = new Map(before?.pulls.map((pull) => [keyOf(pull), JSON.stringify(pull)]) ?? []);
  const is = new Map(after.pulls.map((pull) => [keyOf(pull), JSON.stringify(pull)]));
  let pullsAdded = 0;
  let pullsChanged = 0;
  for (const [key, now] of is) {
    const then = was.get(key);
    if (then === undefined) pullsAdded++;
    else if (then !== now) pullsChanged++;
  }
  const pullsRemoved = [...was.keys()].filter((key) => !is.has(key)).length;
  const projects = new Map(before?.projects.map((one) => [one.repo, JSON.stringify(one)]) ?? []);
  const projectsChanged = after.projects.filter((one) => projects.get(one.repo) !== JSON.stringify(one)).length;
  return { projectsChanged, pullsAdded, pullsRemoved, pullsChanged };
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
