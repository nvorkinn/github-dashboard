/**
 * The release runs as the relay tells them (see relay/src/releases.ts): the page reads none of them from GitHub. The
 * relay sends all of them when the page connects (`releases`) and then each run whole as it changes (`run`).
 *
 * What comes over the stream is checked before it is shown: every field must be there, of its type, and every link
 * must go to github.com, since a click opens it.
 */
import type {
  Approval,
  CheckState,
  Job,
  JobGraph,
  JobNode,
  ReleaseRun,
  ReleasesSnapshot,
} from "../../../shared/runs.ts";

const STATES: readonly string[] = [
  "queued",
  "running",
  "waiting",
  "passed",
  "failed",
  "cancelled",
  "skipped",
  "neutral",
] satisfies CheckState[];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optional(value: unknown): string | undefined | null {
  return value === undefined || typeof value === "string" ? value : null;
}

function link(value: unknown): string | undefined | null {
  return value === undefined || (typeof value === "string" && value.startsWith("https://github.com/")) ? value : null;
}

/** Each of `values` read by `read`, or nothing if `values` is no list or one of them is nothing. */
function all<T>(values: unknown, read: (value: unknown) => T | undefined): T[] | undefined {
  if (!Array.isArray(values)) {
    return undefined;
  }
  const found: T[] = [];
  for (const value of values) {
    const one = read(value);
    if (one === undefined) {
      return undefined;
    }
    found.push(one);
  }
  return found;
}

function job(value: unknown): Job | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const { id, name, state } = value;
  const url = link(value.url);
  const startedAt = optional(value.startedAt);
  const finishedAt = optional(value.finishedAt);
  if (
    typeof id !== "number" ||
    typeof name !== "string" ||
    typeof state !== "string" ||
    !STATES.includes(state) ||
    url === null ||
    startedAt === null ||
    finishedAt === null
  ) {
    return undefined;
  }
  return { id, name, state: state as CheckState, url, startedAt, finishedAt };
}

function node(value: unknown): JobNode | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const { key, name, several } = value;
  const needs = all(value.needs, (one) => (typeof one === "string" ? one : undefined));
  const jobs = all(value.jobs, job);
  if (typeof key !== "string" || typeof name !== "string" || typeof several !== "boolean" || !needs || !jobs) {
    return undefined;
  }
  return { key, name, needs, several, jobs };
}

function graph(value: unknown): JobGraph | undefined {
  const nodes = isRecord(value) ? all(value.nodes, node) : undefined;
  const unplaced = isRecord(value) ? all(value.unplaced, job) : undefined;
  return nodes && unplaced ? { nodes, unplaced } : undefined;
}

function approval(value: unknown): Approval | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const { environmentId, environment, canApprove } = value;
  return typeof environmentId === "number" && typeof environment === "string" && typeof canApprove === "boolean"
    ? { environmentId, environment, canApprove }
    : undefined;
}

/** One run as the relay sent it, or nothing if it isn't one. */
export function releaseRun(value: unknown): ReleaseRun | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const { repo, id, workflow, title, url, state, startedAt } = value;
  const tag = optional(value.tag);
  const actor = optional(value.actor);
  const finishedAt = optional(value.finishedAt);
  const jobs = all(value.jobs, job);
  const approvals = all(value.approvals, approval);
  // Left out for a run whose workflow file couldn't be read: its jobs then show as they are listed.
  const placed = value.graph === undefined ? undefined : graph(value.graph);
  if (
    typeof repo !== "string" ||
    typeof id !== "number" ||
    typeof workflow !== "string" ||
    typeof title !== "string" ||
    typeof url !== "string" ||
    !url.startsWith("https://github.com/") ||
    typeof state !== "string" ||
    !STATES.includes(state) ||
    typeof startedAt !== "string" ||
    tag === null ||
    actor === null ||
    finishedAt === null ||
    !jobs ||
    !approvals ||
    (value.graph !== undefined && !placed)
  ) {
    return undefined;
  }
  return {
    repo,
    id,
    workflow,
    title,
    ...(tag === undefined ? {} : { tag }),
    url,
    state: state as CheckState,
    actor,
    startedAt,
    finishedAt,
    jobs,
    ...(placed ? { graph: placed } : {}),
    approvals,
  };
}

/** Everything the relay knows of release runs, as it sent it, or nothing if it isn't that. */
export function releasesSnapshot(value: unknown): ReleasesSnapshot | undefined {
  if (!isRecord(value) || typeof value.configured !== "boolean" || !isRecord(value.projects)) {
    return undefined;
  }
  const runs = all(value.runs, releaseRun);
  if (!runs) {
    return undefined;
  }
  const projects: ReleasesSnapshot["projects"] = {};
  for (const [repo, one] of Object.entries(value.projects)) {
    const promoteWorkflow = isRecord(one) ? one.promoteWorkflow : undefined;
    projects[repo] = typeof promoteWorkflow === "number" ? { promoteWorkflow } : {};
  }
  return { configured: value.configured, projects, runs };
}

/** `runs` with `run` in it: in place of the run it was before, or as a new one, the last started first. */
export function withRun(runs: ReleaseRun[], run: ReleaseRun): ReleaseRun[] {
  const others = runs.filter((one) => one.repo !== run.repo || one.id !== run.id);
  return [...others, run].sort((a, b) => b.startedAt.localeCompare(a.startedAt) || b.id - a.id);
}
