/**
 * A release run's jobs as GitHub's graph draws them. GitHub's API gives a run's jobs but not which waits for which:
 * that (`needs:`) comes from the workflow file at the run's commit, read through the contents API. The file at a
 * commit never changes, so what was made of it is kept in memory for as long as the user is signed in.
 */
import {
  RELEASE_MARK,
  readWorkflowBlob,
  WORKFLOWS_FOLDER,
  type WorkflowBlob,
  type WorkflowJob,
  workflowJobs,
} from "../../../shared/workflows.ts";
import { type Api, GitHubError } from "./api.ts";

export {
  jobGraph,
  RELEASE_MARK,
  readWorkflowBlob,
  WORKFLOWS_FOLDER,
  type WorkflowBlob,
  type WorkflowJob,
  workflowJobs,
} from "../../../shared/workflows.ts";

/** How many workflow files are kept. Each is a few names, and a release's commit changes only once per release. */
export const KEPT_FILES = 200;

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

/** How many workflow files' readings are kept. */
export const KEPT_BLOBS = 500;

// Per repository and blob. A blob never changes, so what was read out of it stays true; it is kept in memory for as
// long as the user is signed in, the oldest going first.
const blobs = new Map<string, WorkflowBlob>();

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
