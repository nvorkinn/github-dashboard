/**
 * Pending releases: a project's next release, set to go out on its own once every pull request it waits for has
 * merged. The pull requests can be of any repository the GitHub App reaches. The relay keeps them, fires them from
 * GitHub's webhooks (see relay/src/pending_releases.ts), and tells the pages of them as a whole.
 */

/** One pull request a pending release waits for, and once it merged, how. */
export type PendingPull = {
  /** `owner/name`. */
  repo: string;
  number: number;
  /** Its title when the release was set up, for the page to show without reading it. */
  title: string;
  /** Once it merged: when, and where GitHub said, its merge commit and the branch it merged into. */
  merged?: { at: string; sha?: string | undefined; base?: string | undefined } | undefined;
};

/**
 * `waiting` for its pull requests; `releasing` while the relay publishes it; then `released`, `failed` (`problem` says
 * why), or `cancelled`, by the user or because one of its pull requests closed without merging (`problem` says which).
 */
export type PendingState = "waiting" | "releasing" | "released" | "failed" | "cancelled";

export type PendingRelease = {
  /** Its own id, random. */
  id: string;
  /** The project released: `owner/name`. */
  repo: string;
  pulls: PendingPull[];
  /** The GitHub login of who set it up. */
  by: string;
  createdAt: string;
  state: PendingState;
  /** The tag it gets, from when the relay works it out as it publishes. */
  tag?: string | undefined;
  /** The release on github.com, once published. */
  url?: string | undefined;
  /** Why it failed or was cancelled, in words for the user. */
  problem?: string | undefined;
  /** When it was released, failed or cancelled. */
  endedAt?: string | undefined;
};

/**
 * What the relay tells the pages: whether it can keep pending releases at all (it reads GitHub as the app), and every
 * one it has, the ended ones for a day after.
 */
export type PendingSnapshot = { configured: boolean; pending: PendingRelease[] };

/** At most this many pull requests in one pending release. */
export const MAX_PENDING_PULLS = 20;

const STATES: readonly PendingState[] = ["waiting", "releasing", "released", "failed", "cancelled"];
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SHA = /^[0-9a-f]{40,64}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown, max = 300): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= max ? value : undefined;
}

function whole(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

/** A link only to github.com, since the page opens it. */
function githubUrl(value: unknown): string | undefined {
  const url = str(value, 500);
  return url?.startsWith("https://github.com/") ? url : undefined;
}

/** The repository's full name, if it is one. */
export function repoName(value: unknown): string | undefined {
  const name = str(value, 200);
  return name !== undefined && REPO.test(name) ? name : undefined;
}

function pendingPull(value: unknown): PendingPull | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const repo = repoName(value.repo);
  const number = whole(value.number);
  const title = typeof value.title === "string" ? value.title.slice(0, 300) : undefined;
  if (repo === undefined || number === undefined || title === undefined) {
    return undefined;
  }
  const pull: PendingPull = { repo, number, title };
  if (isRecord(value.merged)) {
    const sha = typeof value.merged.sha === "string" && SHA.test(value.merged.sha) ? value.merged.sha : undefined;
    const base = str(value.merged.base);
    const at = str(value.merged.at, 40);
    if (at === undefined) {
      return undefined;
    }
    pull.merged = { at, ...(sha === undefined ? {} : { sha }), ...(base === undefined ? {} : { base }) };
  }
  return pull;
}

/**
 * A pending release as JSON gave it, or nothing if anything in it isn't of its type: for what the page hears from the
 * relay, and what the relay reads back from its file.
 */
export function pendingRelease(value: unknown): PendingRelease | undefined {
  if (!isRecord(value) || !Array.isArray(value.pulls)) {
    return undefined;
  }
  const id = str(value.id, 64);
  const repo = repoName(value.repo);
  const by = str(value.by, 100);
  const createdAt = str(value.createdAt, 40);
  const state = STATES.find((one) => one === value.state);
  const pulls = value.pulls.map(pendingPull);
  if (
    id === undefined ||
    repo === undefined ||
    by === undefined ||
    createdAt === undefined ||
    state === undefined ||
    pulls.length === 0 ||
    pulls.length > MAX_PENDING_PULLS ||
    pulls.some((one) => one === undefined)
  ) {
    return undefined;
  }
  const pending: PendingRelease = { id, repo, pulls: pulls as PendingPull[], by, createdAt, state };
  const tag = str(value.tag, 100);
  const url = githubUrl(value.url);
  const problem = str(value.problem);
  const endedAt = str(value.endedAt, 40);
  if (tag !== undefined) pending.tag = tag;
  if (url !== undefined) pending.url = url;
  if (problem !== undefined) pending.problem = problem;
  if (endedAt !== undefined) pending.endedAt = endedAt;
  return pending;
}

/** The snapshot an event carries, or nothing if it isn't one; a pending release that isn't one is left out. */
export function pendingSnapshot(value: unknown): PendingSnapshot | undefined {
  if (!isRecord(value) || typeof value.configured !== "boolean" || !Array.isArray(value.pending)) {
    return undefined;
  }
  const pending = value.pending.map(pendingRelease).filter((one): one is PendingRelease => one !== undefined);
  return { configured: value.configured, pending };
}

/** `owner/name#7`, or `name#7` beside a project of the same owner, as a pending release's pull requests are shown. */
export function pullLabel(pull: Pick<PendingPull, "repo" | "number">, beside?: string): string {
  if (beside === pull.repo) {
    return `#${pull.number}`;
  }
  const [owner, name] = pull.repo.split("/");
  return beside?.split("/")[0] === owner ? `${name}#${pull.number}` : `${pull.repo}#${pull.number}`;
}
