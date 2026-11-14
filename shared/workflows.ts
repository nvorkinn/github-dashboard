/**
 * What is read out of a workflow file: its jobs and which waits for which (`needs:`), which GitHub's API doesn't
 * give, and whether the file is marked as a release. Also a run's jobs placed on the file's jobs, as GitHub's graph
 * draws them. The relay and the page both use this.
 */
import type { Job, JobGraph } from "./runs.ts";
import { parseYaml, type Yaml } from "./workflow_yaml.ts";

const EXPRESSION = /\$\{\{.*?\}\}/g;

/** A job as the workflow file has it. */
export type WorkflowJob = {
  key: string;
  /** What the graph calls it: its name, unless that's worked out at run time (then its id, as GitHub's graph does). */
  label: string;
  needs: string[];
  /** A matrix, or a reusable workflow's jobs: several of the run's jobs. */
  several: boolean;
  /** The one name its run's job gets, when the file says it outright. */
  exact: string | undefined;
  /** The names its run's jobs can get, otherwise. */
  pattern: RegExp;
};

/** The jobs of a workflow file, in the file's order. Throws if the text isn't a workflow this can read. */
export function workflowJobs(text: string): WorkflowJob[] {
  const workflow = parseYaml(text);
  const jobs = isMap(workflow) ? workflow.jobs : undefined;
  if (!isMap(jobs) || Object.keys(jobs).length === 0) {
    throw new Error("no jobs in the workflow file");
  }
  return Object.entries(jobs).map(([key, job]) => workflowJob(key, isMap(job) ? job : {}));
}

function workflowJob(key: string, job: { [key: string]: Yaml }): WorkflowJob {
  const needs = typeof job.needs === "string" ? [job.needs] : Array.isArray(job.needs) ? job.needs : [];
  if (!needs.every((one) => typeof one === "string")) {
    throw new Error(`job ${key} needs something that isn't a job`);
  }
  const template = typeof job.name === "string" ? job.name : key;
  const strategy = job.strategy;
  const matrix = isMap(strategy) && strategy.matrix !== undefined && strategy.matrix !== null;
  const uses = typeof job.uses === "string";
  const computed = template.match(EXPRESSION) !== null;
  // GitHub adds a matrix job's values to its name, in brackets, unless the name already uses them; a reusable
  // workflow's jobs are called `<caller> / <their own name>`.
  const pattern = new RegExp(
    `^${template
      .split(EXPRESSION)
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join(".+?")}${matrix ? "( \\(.*\\))?" : ""}${uses ? " / .+" : ""}$`,
  );
  return {
    key,
    label: computed ? key : template,
    needs: needs as string[],
    several: matrix || uses,
    exact: matrix || uses || computed ? undefined : template,
    pattern,
  };
}

function isMap(value: Yaml | undefined): value is { [key: string]: Yaml } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The run's jobs placed on the file's jobs, by name: a job named outright first, else the most specific pattern
 * that matches. Needs that name no job of the file are left out.
 */
export function jobGraph(definitions: WorkflowJob[], jobs: Job[]): JobGraph {
  const keys = new Set(definitions.map((one) => one.key));
  const matched = new Map<string, Job[]>(definitions.map((one) => [one.key, []]));
  const unplaced: Job[] = [];
  for (const job of jobs) {
    const owner = ownerOf(definitions, job.name);
    if (owner) {
      matched.get(owner.key)?.push(job);
    } else {
      unplaced.push(job);
    }
  }
  return {
    nodes: definitions.map((one) => ({
      key: one.key,
      name: one.label,
      needs: one.needs.filter((key) => keys.has(key) && key !== one.key),
      several: one.several,
      jobs: matched.get(one.key) ?? [],
    })),
    unplaced,
  };
}

function ownerOf(definitions: WorkflowJob[], name: string): WorkflowJob | undefined {
  const exact = definitions.find((one) => one.exact === name);
  if (exact) {
    return exact;
  }
  let best: WorkflowJob | undefined;
  for (const one of definitions) {
    if (
      one.exact === undefined &&
      one.pattern.test(name) &&
      (!best || one.pattern.source.length > best.pattern.source.length)
    ) {
      best = one;
    }
  }
  return best;
}

/** Where a repository keeps its workflow files. */
export const WORKFLOWS_FOLDER = ".github/workflows";

/**
 * What marks a workflow file as a release for the dashboard: a comment line of its own saying `dashboard: release`,
 * anywhere in the file.
 */
export const RELEASE_MARK = /^[ \t]*#[ \t]*dashboard:[ \t]*release[ \t]*$/im;

/** What the dashboard reads out of one workflow file. */
export type WorkflowBlob = {
  /** Whether it carries the release mark. */
  marked: boolean;
  /** The workflow's `name`, if the file gives one; GitHub calls a workflow without one by its path. */
  name: string | undefined;
  /** Its jobs; undefined when the text isn't a workflow this can read. */
  jobs: WorkflowJob[] | undefined;
};

/** Reads a workflow file's text. A text that isn't a workflow has no mark, name or jobs. */
export function readWorkflowBlob(text: string): WorkflowBlob {
  let name: string | undefined;
  let jobs: WorkflowJob[] | undefined;
  try {
    const workflow = parseYaml(text);
    name = isMap(workflow) && typeof workflow.name === "string" ? workflow.name : undefined;
  } catch {
    // No name, then.
  }
  try {
    jobs = workflowJobs(text);
  } catch {
    // No graph, then.
  }
  return { marked: RELEASE_MARK.test(text), name, jobs };
}

/**
 * Whether a workflow's name makes it a release: a release, a promotion or a deploy. Only a guess, used for a
 * repository that marks none of its workflow files .
 */
export function isReleaseName(name: string | null | undefined): boolean {
  const lower = (name ?? "").toLowerCase();
  return lower.includes("release") || lower.includes("promote") || lower.includes("deploy");
}

/**
 * Of a repository's workflow files, the paths of the ones whose runs the dashboard shows as releases: the ones that
 * carry the mark; and in a repository that marks none, the ones whose name (or, without one, path) says release,
 * promote or deploy.
 */
export function releasePaths(files: { path: string; blob: WorkflowBlob | undefined }[]): string[] {
  const marked = files.filter((file) => file.blob?.marked);
  const releases = marked.length > 0 ? marked : files.filter((file) => isReleaseName(file.blob?.name ?? file.path));
  return releases.map((file) => file.path);
}
