import type { PullFiles, ReadFiles } from "../model.ts";
import type { Api } from "./api.ts";

// A pull request's files are read up to this many; the rest are left to GitHub's own Files tab.
export const MAX_FILES = 300;
const PAGE_SIZE = 100;

type RawFile = {
  patch?: string;
  filename: string;
  previous_filename?: string;
  status: string;
  additions: number;
  deletions: number;
};

/** The files `number` in `repo` (`owner/name`) changes: at most `MAX_FILES`, a page at a time. */
export async function readPullFiles(api: Api, repo: string, number: number): Promise<PullFiles> {
  const found: RawFile[] = [];
  for (let page = 1; ; page++) {
    const batch = await api.get<RawFile[]>(`repos/${repo}/pulls/${number}/files?per_page=${PAGE_SIZE}&page=${page}`);
    if (!Array.isArray(batch)) {
      throw new Error("GitHub answered with something other than a list of files.");
    }
    found.push(...batch);
    if (batch.length < PAGE_SIZE || found.length > MAX_FILES) {
      break;
    }
  }
  return {
    files: found.slice(0, MAX_FILES).map((file) => ({
      path: file.filename,
      ...(file.patch === undefined ? {} : { patch: file.patch }),
      previousPath: file.previous_filename,
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
    })),
    // GitHub says there are no more only with a page that isn't full, so exactly `MAX_FILES` takes one more read.
    truncated: found.length > MAX_FILES,
  };
}

/**
 * Reads a pull request's files once for each head commit, kept in memory: a new push reads them again. A read that
 * failed is forgotten, so the next asks GitHub again.
 */
export function createFilesReader(api: Api): ReadFiles {
  const read = new Map<string, Promise<PullFiles>>();
  return (pull) => {
    const key = `${pull.repo}#${pull.number}@${pull.sha}`;
    let files = read.get(key);
    if (!files) {
      files = readPullFiles(api, pull.repo, pull.number);
      read.set(key, files);
      files.catch(() => read.delete(key));
    }
    return files;
  };
}
