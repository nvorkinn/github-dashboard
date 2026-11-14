import {
  type Approval,
  job,
  type RawJob,
  type RawRun,
  RECENT_RELEASES,
  type ReleaseRun,
  runOf,
  shownRuns,
} from "../../shared/runs.ts";
import { AppError, type GitHubApp, reasonOf } from "./github_app.ts";
import { isRecord, record, text, wholeNumber } from "./payload.ts";
import type { Definition, Definitions } from "./workflows.ts";

// A run's title is a commit's subject or a `run-name`, which can be long; more than this is cut off.
const MAX_TITLE = 300;
/** How many runs that are no release are remembered as such, so their jobs' webhooks cost nothing. */
export const MAX_IGNORED = 1000;

type KeptJob = RawJob & { attempt: number };

/** One run as the relay holds it: GitHub's words for it and its jobs, and its workflow as it was when it started. */
type Kept = {
  /** Its workflow file. */
  path: string;
  raw: RawRun;
  attempt: number;
  jobs: Map<number, KeptJob>;
  /** The environments it waits for an approval of; undefined when they couldn't be read. */
  approvals: Approval[] | undefined;
  /** Which jobs were waiting when the approvals were read, so they are read again only when that changes. */
  waiting: string;
  definition: Definition;
};

/**
 * The runs of every repository's release workflows, kept in memory: per workflow the runs still going, with their
 * jobs, and the last one that finished. A run is first known from GitHub's `workflow_run` webhook, or from a read of
 * the workflow's latest runs when the relay starts; from then on `workflow_run` and `workflow_job` webhooks say how
 * it and its jobs stand, and the runs still going are read again every so often in case one never came.
 *
 * A run keeps the workflow definition it had when the relay first saw it, so a push that changes the file doesn't
 * redraw a run already going.
 */
export type Runs = {
  /** Takes in a webhook: a run, a job of one, or a deployment waiting for review. */
  onWebhook(kind: string, payload: Record<string, unknown>): void;
  /**
   * Brings the runs of `repo` in line with its release workflows as they are now: forgets the runs of a workflow
   * that is no release any more, and reads the latest runs of one that wasn't read yet.
   */
  reconcile(repo: string): Promise<void>;
  /** Reads every run still going again. */
  recheck(): Promise<void>;
  /** Every run kept, the last started first. */
  all(): ReleaseRun[];
};

export function createRuns(options: {
  app: GitHubApp;
  definitions: Definitions;
  /** One run changed, or is new. */
  onRun(run: ReleaseRun): void;
  /** A run is gone, or several changed: the whole list is to be told again. */
  onRuns(): void;
}): Runs {
  const { app, definitions } = options;
  const repos = new Map<string, Map<number, Kept>>();
  // Per repository: the ids of the release workflows whose latest runs were read.
  const read = new Map<string, string>();
  const ignored = new Set<number>();
  const chains = new Map<string, Promise<void>>();

  /** Runs `work` for `repo` after whatever is under way for it, so two webhooks never change a run at once. */
  function queue(repo: string, work: () => Promise<void>): Promise<void> {
    const next = (chains.get(repo) ?? Promise.resolve()).then(work).catch((error: unknown) => {
      console.warn(`release runs of ${repo} not read: ${reasonOf(error)}`);
    });
    chains.set(repo, next);
    void next.then(() => {
      if (chains.get(repo) === next) {
        chains.delete(repo);
      }
    });
    return next;
  }

  function ignore(id: number): void {
    ignored.add(id);
    if (ignored.size > MAX_IGNORED) {
      ignored.delete(ignored.values().next().value ?? id);
    }
  }

  function model(repo: string, kept: Kept): ReleaseRun {
    const workflow = { name: kept.definition.name };
    // A finished run shows without its jobs.
    return kept.raw.status === "completed"
      ? runOf(repo, workflow, kept.raw, [], undefined, [])
      : runOf(repo, workflow, kept.raw, [...kept.jobs.values()].map(job), kept.definition.jobs, kept.approvals);
  }

  function tell(repo: string, kept: Kept): void {
    options.onRun(model(repo, kept));
  }

  /** Forgets all of a workflow's runs but the ones still going and the last that finished. Says whether any went. */
  function prune(repo: string, path: string): boolean {
    const runs = repos.get(repo);
    const ofPath = [...(runs ?? [])].filter(([, kept]) => kept.path === path);
    const shown = new Set(
      shownRuns(ofPath.map(([id, kept]) => ({ id, status: kept.raw.status }))).map((one) => one.id),
    );
    let gone = false;
    for (const [id] of ofPath) {
      if (!shown.has(id)) {
        runs?.delete(id);
        gone = true;
      }
    }
    return gone;
  }

  function forget(repo: string, id: number): boolean {
    return repos.get(repo)?.delete(id) ?? false;
  }

  /** The run as it is to be kept from now on, given GitHub's latest word for it; undefined for word that is old. */
  function take(repo: string, raw: RawRun, path: string): { kept: Kept; fresh: boolean; again: boolean } | undefined {
    const attempt = raw.run_attempt ?? 1;
    const runs = repos.get(repo) ?? new Map<number, Kept>();
    repos.set(repo, runs);
    const before = runs.get(raw.id);
    if (!before) {
      const definition = definitions.definition(repo, path) ?? { name: raw.name ?? path, jobs: undefined };
      const kept: Kept = { path, raw, attempt, jobs: new Map(), approvals: [], waiting: "", definition };
      runs.set(raw.id, kept);
      return { kept, fresh: true, again: false };
    }
    if (attempt < before.attempt) {
      return undefined;
    }
    if (attempt > before.attempt) {
      // A re-run: its jobs are new ones.
      before.raw = raw;
      before.attempt = attempt;
      before.jobs = new Map();
      before.approvals = [];
      before.waiting = "";
      return { kept: before, fresh: false, again: true };
    }
    // GitHub's webhooks can come out of order: a run that finished doesn't start again without a new attempt.
    if (before.raw.status === "completed" && raw.status !== "completed") {
      return undefined;
    }
    before.raw = raw;
    return { kept: before, fresh: false, again: false };
  }

  function finish(kept: Kept): void {
    if (kept.raw.status === "completed") {
      kept.jobs = new Map();
      kept.approvals = [];
      kept.waiting = "";
    }
  }

  /** Reads the environments a run waits for, when the jobs that wait changed, or anyway with `force`. */
  async function readApprovals(repo: string, id: number, kept: Kept, force = false): Promise<void> {
    const waiting = [...kept.jobs.values()]
      .filter((one) => one.status === "waiting")
      .map((one) => one.id)
      .sort((a, b) => a - b)
      .join(",");
    if (waiting === "") {
      kept.approvals = [];
      kept.waiting = "";
      return;
    }
    const installation = definitions.installationOf(repo);
    if ((!force && waiting === kept.waiting) || installation === undefined) {
      return;
    }
    kept.waiting = waiting;
    try {
      const pending = await app.list<unknown>(installation, `repos/${repo}/actions/runs/${id}/pending_deployments`);
      kept.approvals = pending.flatMap((one) => {
        const environment = record(record(one).environment);
        const environmentId = wholeNumber(environment.id);
        if (environmentId === undefined) {
          return [];
        }
        // Whether the person looking may approve it is theirs to ask: the app is nobody's reviewer.
        return [
          { environmentId, environment: text(environment.name) ?? `environment ${environmentId}`, canApprove: false },
        ];
      });
    } catch (error) {
      console.warn(`approvals of a run of ${repo} not read: ${reasonOf(error)}`);
      // GitHub's word for the jobs stands, and the next change to them asks again.
      kept.approvals = undefined;
      kept.waiting = "";
    }
  }

  /** Reads the jobs of a run's latest attempt, and what it waits for. */
  async function readJobs(repo: string, id: number, kept: Kept): Promise<void> {
    const installation = definitions.installationOf(repo);
    if (installation === undefined) {
      return;
    }
    const jobs = await app.list<unknown>(installation, `repos/${repo}/actions/runs/${id}/jobs`, "jobs");
    kept.jobs = new Map(jobs.flatMap((one) => keptJob(one) ?? []).map((one) => [one.id, one]));
    await readApprovals(repo, id, kept, true);
  }

  /** Reads one run by itself, with its jobs: one not known yet, or one whose webhooks may have been missed. */
  async function readRun(repo: string, id: number): Promise<void> {
    const installation = definitions.installationOf(repo);
    if (installation === undefined) {
      return;
    }
    let raw: RawRun | undefined;
    try {
      raw = rawRun(await app.get<unknown>(installation, `repos/${repo}/actions/runs/${id}`));
    } catch (error) {
      if (!(error instanceof AppError) || error.status !== 404) {
        throw error;
      }
    }
    const path = raw ? fileOf(raw.path) : undefined;
    if (!raw || path === undefined || !definitions.isRelease(repo, path)) {
      // Deleted, or of a workflow that is no release.
      ignore(id);
      if (forget(repo, id)) {
        options.onRuns();
      }
      return;
    }
    const taken = take(repo, raw, path);
    if (!taken) {
      return;
    }
    finish(taken.kept);
    if (raw.status !== "completed") {
      await readJobs(repo, id, taken.kept);
    }
    if (prune(repo, path)) {
      options.onRuns();
    } else {
      tell(repo, taken.kept);
    }
  }

  async function onRun(repo: string, payload: Record<string, unknown>): Promise<void> {
    const raw = rawRun(payload.workflow_run);
    if (!raw) {
      return;
    }
    // A run can start with the push that changed its workflow file: that file is read first.
    await definitions.settled(repo);
    const path = fileOf(raw.path);
    if (path === undefined || !definitions.isRelease(repo, path)) {
      ignore(raw.id);
      if (forget(repo, raw.id)) {
        options.onRuns();
      }
      return;
    }
    ignored.delete(raw.id);
    const taken = take(repo, raw, path);
    if (!taken) {
      return;
    }
    finish(taken.kept);
    // Its jobs are told one by one as they start, but not the ones a run had before the relay knew it, nor the ones
    // a re-run of some jobs leaves as they were.
    if (raw.status !== "completed" && ((taken.fresh && payload.action !== "requested") || taken.again)) {
      await readJobs(repo, raw.id, taken.kept).catch((error: unknown) => {
        console.warn(`jobs of a run of ${repo} not read: ${reasonOf(error)}`);
      });
    }
    if (prune(repo, path)) {
      options.onRuns();
    } else {
      tell(repo, taken.kept);
    }
  }

  async function onJob(repo: string, payload: Record<string, unknown>): Promise<void> {
    const one = keptJob(payload.workflow_job);
    const id = wholeNumber(record(payload.workflow_job).run_id);
    if (!one || id === undefined || ignored.has(id)) {
      return;
    }
    await definitions.settled(repo);
    const kept = repos.get(repo)?.get(id);
    if (!kept || one.attempt > kept.attempt) {
      // A run not heard of, or a re-run whose own webhook is still on its way: GitHub is asked how it stands.
      await readRun(repo, id);
      return;
    }
    if (one.attempt < kept.attempt || kept.raw.status === "completed") {
      return;
    }
    // Out of order, as for a run: a job doesn't go back.
    const before = kept.jobs.get(one.id);
    if (before && rank(before.status) > rank(one.status)) {
      return;
    }
    kept.jobs.set(one.id, one);
    await readApprovals(repo, id, kept);
    tell(repo, kept);
  }

  async function onReview(repo: string, payload: Record<string, unknown>): Promise<void> {
    const id = wholeNumber(record(payload.workflow_run).id);
    if (id === undefined || ignored.has(id)) {
      return;
    }
    const kept = repos.get(repo)?.get(id);
    if (!kept) {
      await readRun(repo, id);
    } else if (kept.raw.status !== "completed") {
      await readApprovals(repo, id, kept, true);
      tell(repo, kept);
    }
  }

  /** Reads the latest runs of each of the repository's release workflows. */
  async function readLatest(repo: string): Promise<void> {
    const installation = definitions.installationOf(repo);
    if (installation === undefined) {
      return;
    }
    await Promise.all(
      definitions.releaseWorkflows(repo).map(async (workflow) => {
        const answer = await app.get<unknown>(
          installation,
          `repos/${repo}/actions/workflows/${workflow.id}/runs?per_page=${RECENT_RELEASES}`,
        );
        const listed = record(answer).workflow_runs;
        const latest = (Array.isArray(listed) ? listed : []).flatMap((one) => rawRun(one) ?? []);
        for (const raw of shownRuns(latest)) {
          const taken = take(repo, raw, workflow.path);
          if (!taken) {
            continue;
          }
          finish(taken.kept);
          if (raw.status !== "completed") {
            await readJobs(repo, raw.id, taken.kept);
          }
        }
        prune(repo, workflow.path);
      }),
    );
  }

  return {
    onWebhook(kind, payload) {
      const repo = text(record(payload.repository).full_name);
      const handler = kind === "workflow_run" ? onRun : kind === "workflow_job" ? onJob : onReview;
      if (repo !== undefined && (kind === "workflow_run" || kind === "workflow_job" || kind === "deployment_review")) {
        void queue(repo, () => handler(repo, payload));
      }
    },

    reconcile(repo) {
      return queue(repo, async () => {
        const workflows = definitions.releaseWorkflows(repo);
        const runs = repos.get(repo);
        for (const [id, kept] of [...(runs ?? [])]) {
          if (!definitions.isRelease(repo, kept.path)) {
            runs?.delete(id);
          }
        }
        if (runs?.size === 0) {
          repos.delete(repo);
        }
        const key = workflows
          .map((one) => one.id)
          .sort((a, b) => a - b)
          .join(",");
        if (read.get(repo) === key) {
          return;
        }
        if (workflows.length === 0) {
          read.delete(repo);
          return;
        }
        await readLatest(repo);
        // Only now: a read that failed is tried again the next time the repository's workflows are looked at.
        read.set(repo, key);
      });
    },

    async recheck() {
      await Promise.all(
        [...repos].map(([repo, runs]) =>
          queue(repo, async () => {
            for (const [id, kept] of [...runs]) {
              if (kept.raw.status !== "completed") {
                await readRun(repo, id);
              }
            }
          }),
        ),
      );
    },

    all() {
      return [...repos]
        .flatMap(([repo, runs]) => [...runs.values()].map((kept) => model(repo, kept)))
        .sort((a, b) => b.startedAt.localeCompare(a.startedAt) || b.id - a.id);
    },
  };
}

/** A run's workflow file, from its `path`, which can end in `@<ref>`. */
function fileOf(path: string | undefined): string | undefined {
  return path?.split("@")[0] || undefined;
}

function rank(status: string): number {
  return status === "completed" ? 2 : status === "in_progress" ? 1 : 0;
}

function str(value: unknown, max = MAX_TITLE): string | undefined {
  return typeof value === "string" && value.length > 0 ? value.slice(0, max) : undefined;
}

/** A time as GitHub writes it, or nothing. */
function time(value: unknown): string | undefined {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : undefined;
}

/** An address on github.com, or nothing: the page opens it on a click. */
function link(value: unknown): string | undefined {
  return typeof value === "string" && value.startsWith("https://github.com/") ? value.slice(0, 500) : undefined;
}

function login(value: unknown): { login: string } | null {
  const name = text(record(value).login);
  return name === undefined ? null : { login: name };
}

/**
 * A run as GitHub gives it, in a webhook or an answer of its API, read defensively: a value of an unexpected type
 * counts as missing, and a run missing what makes it one is nothing.
 */
export function rawRun(value: unknown): RawRun | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const id = wholeNumber(value.id);
  const url = link(value.html_url);
  const created = time(value.created_at);
  if (id === undefined || url === undefined || created === undefined) {
    return undefined;
  }
  const title = str(value.display_title);
  const branch = str(value.head_branch);
  const event = text(value.event);
  const started = time(value.run_started_at);
  const sha = text(value.head_sha);
  const path = text(value.path);
  return {
    id,
    name: str(value.name) ?? null,
    ...(title === undefined ? {} : { display_title: title }),
    ...(branch === undefined ? {} : { head_branch: branch }),
    ...(event === undefined ? {} : { event }),
    html_url: url,
    status: text(value.status) ?? null,
    conclusion: text(value.conclusion) ?? null,
    actor: login(value.actor),
    triggering_actor: login(value.triggering_actor),
    created_at: created,
    ...(started === undefined ? {} : { run_started_at: started }),
    updated_at: time(value.updated_at) ?? created,
    ...(sha === undefined ? {} : { head_sha: sha }),
    ...(path === undefined ? {} : { path }),
    run_attempt: wholeNumber(value.run_attempt) ?? 1,
  };
}

/** A job as GitHub gives it, read as `rawRun` reads a run. */
function keptJob(value: unknown): KeptJob | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const id = wholeNumber(value.id);
  const name = str(value.name);
  const status = text(value.status);
  if (id === undefined || name === undefined || status === undefined) {
    return undefined;
  }
  return {
    id,
    name,
    status,
    conclusion: text(value.conclusion) ?? null,
    html_url: link(value.html_url) ?? null,
    started_at: time(value.started_at) ?? null,
    completed_at: time(value.completed_at) ?? null,
    attempt: wholeNumber(value.run_attempt) ?? 1,
  };
}
