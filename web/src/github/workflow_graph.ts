/**
 * A release run's jobs as GitHub's graph draws them. GitHub's API gives a run's jobs but not which waits for which:
 * that (`needs:`) comes from the workflow file at the run's commit, read through the contents API. The file at a
 * commit never changes, so what was made of it is kept in memory for as long as the user is signed in.
 */
import type { Job, JobGraph } from "../model.ts";
import { type Api, GitHubError } from "./api.ts";
import { parseYaml, type Yaml } from "./workflow_yaml.ts";

/** How many workflow files are kept. Each is a few names, and a release's commit changes only once per release. */
export const KEPT_FILES = 200;

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

// Per repository, path and commit: the file's jobs, or undefined for a file that isn't there or can't be read as a
// workflow. Both stay so forever. A read under way is kept too, so runs of the same commit share it.
const files = new Map<string, Promise<WorkflowJob[] | undefined>>();

/** Forgets every workflow file read, such as on sign-out. */
export function forgetWorkflowFiles(): void {
  files.clear();
  marks.clear();
  blobs.clear();
}

/**
 * The jobs of the workflow file `path` of `repo` as at commit `sha`; undefined when it can't be had, and the run's
 * jobs are then shown without the graph. A rate limit, a sign-in GitHub no longer accepts or a failing network is
 * thrown, as for every other read.
 */
export function workflowFile(api: Api, repo: string, path: string, sha: string): Promise<WorkflowJob[] | undefined> {
  // A workflow run's path can end in `@<ref>`.
  const file = path.split("@")[0] ?? path;
  const key = `${repo}\n${file}\n${sha}`;
  const kept = files.get(key);
  if (kept) {
    // The newest used last, so the oldest goes first.
    files.delete(key);
    files.set(key, kept);
    return kept;
  }
  const reading: Promise<WorkflowJob[] | undefined> = readWorkflowFile(api, repo, file, sha).catch((error: unknown) => {
    // Not kept: it's asked again on the next read.
    if (files.get(key) === reading) {
      files.delete(key);
    }
    if (error instanceof GitHubError && error.retryAt === undefined && error.status !== 401) {
      // Some other refusal: no graph this time.
      return undefined;
    }
    throw error;
  });
  files.set(key, reading);
  while (files.size > KEPT_FILES) {
    const oldest = files.keys().next().value;
    if (oldest === undefined) {
      break;
    }
    files.delete(oldest);
  }
  return reading;
}

async function readWorkflowFile(api: Api, repo: string, path: string, sha: string): Promise<WorkflowJob[] | undefined> {
  let raw: { content?: string; encoding?: string } | unknown[];
  try {
    raw = await api.get(`repos/${repo}/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${sha}`);
  } catch (error) {
    // No such file at that commit, which stays so.
    if (error instanceof GitHubError && error.status === 404) {
      return undefined;
    }
    throw error;
  }
  // A directory is a list; a file over a megabyte comes without its content.
  if (Array.isArray(raw) || raw.encoding !== "base64" || typeof raw.content !== "string") {
    return undefined;
  }
  try {
    return workflowJobs(decodeBase64(raw.content));
  } catch {
    return undefined;
  }
}

/** Where a repository keeps its workflow files. */
export const WORKFLOWS_FOLDER = ".github/workflows";

/**
 * What marks a workflow file as a release for the dashboard: a comment line of its own saying `dashboard: release`,
 * anywhere in the file.
 */
export const RELEASE_MARK = /^[ \t]*#[ \t]*dashboard:[ \t]*release[ \t]*$/im;

// Per repository and blob: whether the file with that content carries the mark. A blob never changes, so it stays.
const marks = new Map<string, Promise<boolean>>();

/**
 * The paths of the repository's workflow files, on its default branch, that carry the release mark. One request
 * lists the folder; a file is read only the first time its content is seen. A repository without the folder, or
 * one whose files GitHub won't show, has none; a rate limit, a sign-in GitHub no longer accepts or a failing network
 * is thrown, as for every other read.
 */
export async function markedReleaseFiles(api: Api, repo: string): Promise<Set<string>> {
  const quiet =
    <T>(fallback: T) =>
    (error: unknown): T => {
      if (error instanceof GitHubError && error.retryAt === undefined && error.status !== 401) {
        return fallback;
      }
      throw error;
    };
  const listing = await api
    .get<{ type?: string; path?: string; sha?: string }[] | unknown>(`repos/${repo}/contents/${WORKFLOWS_FOLDER}`)
    .catch(quiet(undefined));
  const marked = new Set<string>();
  if (!Array.isArray(listing)) {
    return marked;
  }
  await Promise.all(
    listing.map(async (entry: { type?: string; path?: string; sha?: string }) => {
      const { path, sha } = entry;
      if (entry.type !== "file" || !path || !sha || !/\.ya?ml$/.test(path)) {
        return;
      }
      const key = `${repo}\n${sha}`;
      let reading = marks.get(key);
      if (!reading) {
        reading = api
          .get<{ content?: string; encoding?: string }>(`repos/${repo}/git/blobs/${sha}`)
          .then((blob) => blob.encoding === "base64" && RELEASE_MARK.test(decodeBase64(blob.content ?? "")));
        marks.set(key, reading);
        // Not kept when it failed: it's asked again on the next read.
        reading.catch(() => marks.delete(key));
      }
      if (await reading.catch(quiet(false))) {
        marked.add(path);
      }
    }),
  );
  return marked;
}

function decodeBase64(text: string): string {
  const binary = atob(text.replace(/\s/g, ""));
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/** What the dashboard reads out of one workflow file. */
export type WorkflowBlob = {
  /** Whether it carries the release mark. */
  marked: boolean;
  /** The workflow's `name`, if the file gives one; GitHub calls a workflow without one by its path. */
  name: string | undefined;
  /** Its jobs; undefined when the text isn't a workflow this can read. */
  jobs: WorkflowJob[] | undefined;
};

/** How many workflow files' readings are kept. */
export const KEPT_BLOBS = 500;

// Per repository and blob. A blob never changes, so what was read out of it stays true; it is kept in memory for as
// long as the user is signed in, the oldest going first.
const blobs = new Map<string, WorkflowBlob>();

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

/** What was read out of the blob `oid` of `repo`, if it was kept. */
export function keptWorkflowBlob(repo: string, oid: string): WorkflowBlob | undefined {
  return blobs.get(`${repo}\n${oid}`);
}

/** Reads the blob `oid` of `repo` from its text, and keeps the reading. */
export function keepWorkflowBlob(repo: string, oid: string, text: string): WorkflowBlob {
  const blob = readWorkflowBlob(text);
  blobs.set(`${repo}\n${oid}`, blob);
  while (blobs.size > KEPT_BLOBS) {
    const oldest = blobs.keys().next().value;
    if (oldest === undefined) {
      break;
    }
    blobs.delete(oldest);
  }
  return blob;
}

/** Whether any workflow file's reading is kept: none is on a page that has just loaded. */
export function hasWorkflowBlobs(): boolean {
  return blobs.size > 0;
}
