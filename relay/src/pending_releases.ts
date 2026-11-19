import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type Context, Hono } from "hono";
import {
  MAX_PENDING_PULLS,
  type PendingPull,
  type PendingRelease,
  type PendingSnapshot,
  pendingRelease,
  pullLabel,
  repoName,
} from "../../shared/pending.ts";
import { nextVersion } from "../../shared/versions.ts";
import { sameOrigin } from "./auth.ts";
import { AppError, type GitHubApp, reasonOf } from "./github_app.ts";
import type { Notice } from "./notices.ts";
import { commit, record, text, wholeNumber } from "./payload.ts";
import { withPurpose } from "./telemetry.ts";

/** The file the pending releases are kept in, in `DATA_DIR`. */
export const PENDING_FILE = "pending-releases.json";
/** How often the pull requests still waited for are read again, in case a webhook never came. */
export const RECHECK_MS = 5 * 60_000;
/** How long a pending release that ended is still told, so the page can say how it went. */
export const ENDED_MS = 24 * 60 * 60_000;
/** At most this many pending releases wait at once. */
export const MAX_WAITING = 50;
/** A release that fails because GitHub didn't answer is tried again at the next recheck, this many times in all. */
export const MAX_TRIES = 3;

const API = "https://api.github.com";
const TIMEOUT_MS = 10_000;
const MAX_BODY_BYTES = 16 * 1024;

/** Words for the user that the relay gives back as they are. */
class Refusal extends Error {
  status: 400 | 401 | 403 | 404 | 409 | 503;

  constructor(status: Refusal["status"], message: string) {
    super(message);
    this.status = status;
  }
}

export type PendingReleases = {
  /** Every pending release, the ended ones for `ENDED_MS` after. */
  snapshot(): PendingSnapshot;
  /** Takes in a signed webhook: a pull request closing is what moves a pending release on. */
  onWebhook(kind: string, payload: Record<string, unknown>): void;
  /** `POST /` sets up a project's pending release; `DELETE /:id` cancels one, or forgets one that ended. */
  routes: Hono;
  /** Resolves once the first recheck after starting is through. */
  ready: Promise<void>;
};

/**
 * Pending releases: "release this project once these pull requests have merged". The user sets one up on the page;
 * the relay keeps it, hears from GitHub's webhooks as each pull request closes, and once the last of them has merged
 * publishes the project's next minor release as the GitHub App, as the page's Release button would as the user. A
 * pull request closing without merging cancels the whole release. Each outcome is a notice (`notify`).
 *
 * The release is of the merge commit of the last of its pull requests that went into the project's default branch,
 * so that whatever merges after it waits for the next one; when none of them is the project's own, it is of the
 * default branch's head.
 *
 * They are kept in `DATA_DIR/pending-releases.json`, so they last through a restart, and the pull requests still
 * waited for are read again at the start and every `RECHECK_MS`, for a webhook missed meanwhile. Without `dataDir`
 * they live in memory only. Without `app` nothing can be set up, and the routes answer 503.
 *
 * Setting one up or cancelling it is asked for with the user's own GitHub token (`Authorization: Bearer`), from the
 * page only. The relay asks GitHub with that token who the user is, that they may push to the project, and that each
 * pull request is open where they can see it; the token goes nowhere else and isn't kept.
 */
export function createPendingReleases(options: {
  app: GitHubApp | undefined;
  /** The installation of the app that reaches a repository. */
  installationOf(repo: string): number | undefined;
  /** Resolves once the repositories the app reaches are known. */
  reposKnown: Promise<void>;
  dataDir?: string | undefined;
  /** Where the page is, for telling its requests from others' when the browser doesn't say. */
  publicOrigin?: string | undefined;
  /** Reaches api.github.com as the user. */
  fetch?: typeof fetch;
  /** The pending releases changed: everything is told again. */
  onSnapshot(snapshot: PendingSnapshot): void;
  /** One was released, failed, or was cancelled by a pull request closing. */
  notify(notice: Notice): void;
  closing?: AbortSignal | undefined;
  recheckMs?: number | undefined;
}): PendingReleases {
  const { app } = options;
  const fetcher = options.fetch ?? fetch;
  const file = options.dataDir ? join(options.dataDir, PENDING_FILE) : undefined;
  let all: PendingRelease[] = load(file);
  // Tries so far of each release GitHub didn't answer for. Not kept: a restart gives them all their tries again.
  const tries = new Map<string, number>();

  // Every change goes through here, one at a time, so a webhook and a recheck never move the same one at once.
  let chain: Promise<unknown> = Promise.resolve();
  function serial<T>(work: () => Promise<T>): Promise<T> {
    const next = chain.then(work);
    chain = next.catch(() => {});
    return next;
  }

  function snapshot(): PendingSnapshot {
    const now = Date.now();
    all = all.filter((one) => !one.endedAt || now - Date.parse(one.endedAt) < ENDED_MS);
    return { configured: app !== undefined, pending: all.map((one) => structuredClone(one)) };
  }

  // Writes go one after another, each the whole list, through a file beside it, so a crash leaves the old or the new.
  let saving: Promise<void> = Promise.resolve();
  function changed(): Promise<void> {
    const now = snapshot();
    options.onSnapshot(now);
    if (!file) {
      return Promise.resolve();
    }
    const body = `${JSON.stringify(now.pending, null, 2)}\n`;
    saving = saving.then(async () => {
      try {
        await writeFile(`${file}.tmp`, body, { mode: 0o600 });
        await rename(`${file}.tmp`, file);
      } catch (error) {
        console.warn(`pending releases not saved: ${error instanceof Error ? error.name : "unknown error"}`);
      }
    });
    return saving;
  }

  function end(one: PendingRelease, state: "released" | "failed" | "cancelled", problem?: string): void {
    one.state = state;
    one.endedAt = new Date().toISOString();
    if (problem !== undefined) {
      one.problem = problem;
    }
    tries.delete(one.id);
  }

  /** What GitHub says of one pull request closing, for every pending release that waits for it. */
  async function closed(repo: string, number: number, merged: PendingPull["merged"] | undefined): Promise<void> {
    let any = false;
    const ready: PendingRelease[] = [];
    for (const one of all) {
      const pull = one.state === "waiting" ? one.pulls.find((p) => p.repo === repo && p.number === number) : undefined;
      if (!pull || pull.merged) {
        continue;
      }
      any = true;
      if (!merged) {
        const label = pullLabel(pull, one.repo);
        end(one, "cancelled", `${label} was closed without merging.`);
        options.notify(
          notice(one, "cancelled", `Release of ${one.repo} cancelled: ${label} closed without merging`, pullUrl(pull)),
        );
        continue;
      }
      pull.merged = merged;
      if (one.pulls.every((p) => p.merged)) {
        one.state = "releasing";
        ready.push(one);
      }
    }
    if (any) {
      await changed();
    }
    for (const one of ready) {
      await release(one);
    }
  }

  /** Publishes the release, or says why not. Called with `state` already `releasing`. */
  async function release(one: PendingRelease): Promise<void> {
    await options.reposKnown;
    const installation = options.installationOf(one.repo);
    if (!app || installation === undefined) {
      end(one, "failed", `The GitHub App no longer reaches ${one.repo}.`);
      await changed();
      options.notify(notice(one, "failed", `Release of ${one.repo} failed: the GitHub App no longer reaches it`));
      return;
    }
    try {
      const repo = await app.get<{ default_branch?: unknown }>(installation, `repos/${one.repo}`);
      const branch = text(repo.default_branch);
      if (one.tag !== undefined) {
        // Tried before, maybe published before the relay heard back: then it is out already.
        const found = await absent(
          app.get<{ html_url?: unknown }>(
            installation,
            `repos/${one.repo}/releases/tags/${encodeURIComponent(one.tag)}`,
          ),
        );
        if (found) {
          return await released(one, found.html_url);
        }
      } else {
        const releases = await app.list<{ tag_name?: unknown; draft?: unknown }>(
          installation,
          `repos/${one.repo}/releases`,
        );
        const next = nextVersion(
          releases.filter((r) => r.draft !== true).flatMap((r) => (typeof r.tag_name === "string" ? [r.tag_name] : [])),
        );
        if (!next) {
          throw new Refusal(409, "No release has a version tag such as v1.19.0, so the next one isn't known.");
        }
        if (await absent(app.get(installation, `repos/${one.repo}/git/ref/tags/${encodeURIComponent(next.tag)}`))) {
          throw new Refusal(409, `Tag ${next.tag} already exists. Resolve it on GitHub, then release by hand.`);
        }
        one.tag = next.tag;
        await changed();
      }
      const own = one.pulls
        .filter((p) => p.repo === one.repo && p.merged?.sha !== undefined && p.merged.base === branch)
        .sort((a, b) => Date.parse(a.merged?.at ?? "") - Date.parse(b.merged?.at ?? ""));
      const target = own.at(-1)?.merged?.sha ?? branch;
      const made = await app.post<{ html_url?: unknown }>(installation, `repos/${one.repo}/releases`, {
        tag_name: one.tag,
        ...(target ? { target_commitish: target } : {}),
        generate_release_notes: true,
        draft: false,
        prerelease: false,
      });
      await released(one, made.html_url);
    } catch (error) {
      const tried = (tries.get(one.id) ?? 0) + 1;
      const transient = error instanceof AppError && (error.status === 0 || error.status >= 500);
      if (transient && tried < MAX_TRIES) {
        // Still `releasing`: the next recheck tries again.
        tries.set(one.id, tried);
        console.warn(`pending release of ${one.repo} not published yet: ${reasonOf(error)}`);
        return;
      }
      const problem =
        error instanceof Refusal ? error.message : `GitHub refused the release (${reasonOf(error)}). Release by hand.`;
      end(one, "failed", problem);
      await changed();
      options.notify(notice(one, "failed", `Release of ${one.repo} failed: ${problem}`));
    }
  }

  async function released(one: PendingRelease, url: unknown): Promise<void> {
    const link = typeof url === "string" && url.startsWith("https://github.com/") ? url : undefined;
    if (link) {
      one.url = link;
    }
    end(one, "released");
    await changed();
    const after = one.pulls.map((p) => pullLabel(p, one.repo)).join(", ");
    options.notify(notice(one, "released", `Released ${one.repo} ${one.tag ?? ""} after ${after} merged`, link));
  }

  /** Reads the pull requests still waited for again, and publishes what was left half-way. */
  async function recheck(): Promise<void> {
    if (!app) {
      return;
    }
    await options.reposKnown;
    for (const one of all.filter((p) => p.state === "releasing")) {
      await serial(() => (one.state === "releasing" ? release(one) : Promise.resolve()));
    }
    const asked = new Set<string>();
    for (const one of all.filter((p) => p.state === "waiting")) {
      for (const pull of one.pulls.filter((p) => !p.merged)) {
        const key = `${pull.repo}#${pull.number}`;
        const installation = options.installationOf(pull.repo);
        if (asked.has(key) || installation === undefined) {
          continue;
        }
        asked.add(key);
        try {
          const read = await app.get<Record<string, unknown>>(installation, `repos/${pull.repo}/pulls/${pull.number}`);
          if (read.state === "closed") {
            await serial(() => closed(pull.repo, pull.number, mergedOf(read)));
          }
        } catch (error) {
          console.warn(`pending release: ${key} not read again: ${reasonOf(error)}`);
        }
      }
    }
  }

  const ready = withPurpose("pending.start", () => recheck()).catch(() => {});
  if (app && !options.closing?.aborted) {
    const timer = setInterval(
      () => void withPurpose("pending.recheck", () => recheck()),
      options.recheckMs ?? RECHECK_MS,
    );
    timer.unref();
    options.closing?.addEventListener("abort", () => clearInterval(timer));
  }

  /** GitHub as the user whose token came with the request. */
  async function asUser<T>(token: string, path: string): Promise<T | undefined> {
    let response: Response;
    try {
      response = await fetcher(`${API}/${path}`, {
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "github-dashboard-relay",
        },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      throw new Refusal(503, "GitHub didn't answer. Try again.");
    }
    if (response.status === 401) {
      await response.body?.cancel().catch(() => {});
      throw new Refusal(401, "GitHub no longer takes your sign-in. Reload the page.");
    }
    if (response.status === 404 || response.status === 403) {
      await response.body?.cancel().catch(() => {});
      return undefined;
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new Refusal(503, `GitHub answered ${response.status}. Try again.`);
    }
    return (await response.json()) as T;
  }

  /** Who asks, and that they may release `repo`. */
  async function allowed(c: Context, repo: string): Promise<{ token: string; login: string }> {
    const token = /^Bearer ([\w.-]{1,512})$/.exec(c.req.header("Authorization") ?? "")?.[1];
    if (!token) {
      throw new Refusal(401, "Sign in first.");
    }
    const user = await asUser<{ login?: unknown }>(token, "user");
    const login = text(user?.login);
    if (!login) {
      throw new Refusal(401, "GitHub didn't say who you are. Reload the page.");
    }
    const project = await asUser<{ permissions?: { push?: unknown } }>(token, `repos/${repo}`);
    if (project?.permissions?.push !== true) {
      throw new Refusal(403, `You can't release ${repo}: it takes write access.`);
    }
    return { token, login };
  }

  const routes = new Hono();
  routes.use("/*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    if (!app) {
      return c.text("Pending releases need the GitHub App: set GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY", 503);
    }
    if (c.req.method !== "GET" && !sameOrigin(c, options.publicOrigin)) {
      return c.text("Cross-site request refused", 403);
    }
    return next();
  });
  routes.onError((error, c) => {
    if (error instanceof Refusal) {
      return c.text(error.message, error.status);
    }
    console.warn(`pending release request failed: ${error instanceof Error ? error.name : "unknown error"}`);
    return c.text("That didn't work. Try again.", 500);
  });

  routes.get("/", (c) => c.json(snapshot()));

  routes.post("/", async (c) => {
    if (Number(c.req.header("Content-Length") ?? "0") > MAX_BODY_BYTES) {
      throw new Refusal(400, "Too much asked at once.");
    }
    const body: unknown = await c.req.json().catch(() => undefined);
    const repo = repoName(record(body).repo);
    const raw = record(body).pulls;
    if (repo === undefined || !Array.isArray(raw)) {
      throw new Refusal(400, "Say which project to release and which pull requests it waits for.");
    }
    const wanted = new Map<string, { repo: string; number: number }>();
    for (const entry of raw) {
      const pullRepo = repoName(record(entry).repo);
      const number = wholeNumber(record(entry).number);
      if (pullRepo === undefined || number === undefined) {
        throw new Refusal(400, "A pull request is named wrongly.");
      }
      wanted.set(`${pullRepo}#${number}`, { repo: pullRepo, number });
    }
    if (wanted.size === 0 || wanted.size > MAX_PENDING_PULLS) {
      throw new Refusal(400, `Pick between 1 and ${MAX_PENDING_PULLS} pull requests.`);
    }
    await options.reposKnown;
    const { token, login } = await allowed(c, repo);
    for (const name of new Set([repo, ...[...wanted.values()].map((p) => p.repo)])) {
      if (options.installationOf(name) === undefined) {
        throw new Refusal(400, `The GitHub App isn't installed on ${name}, so the relay can't follow it.`);
      }
    }
    const pulls: PendingPull[] = [];
    for (const { repo: pullRepo, number } of wanted.values()) {
      const read = await asUser<Record<string, unknown>>(token, `repos/${pullRepo}/pulls/${number}`);
      const label = pullLabel({ repo: pullRepo, number }, repo);
      if (!read) {
        throw new Refusal(400, `${label} wasn't found.`);
      }
      if (read.state !== "open") {
        throw new Refusal(400, `${label} isn't open any more.`);
      }
      pulls.push({ repo: pullRepo, number, title: (typeof read.title === "string" ? read.title : "").slice(0, 300) });
    }
    await serial(async () => {
      const before = all.find((one) => one.repo === repo && (one.state === "waiting" || one.state === "releasing"));
      if (before?.state === "releasing") {
        throw new Refusal(409, `${repo} is being released right now.`);
      }
      if (!before && all.filter((one) => one.state === "waiting").length >= MAX_WAITING) {
        throw new Refusal(409, `There are ${MAX_WAITING} pending releases already.`);
      }
      // One pending release per project: setting one up again changes what it waits for.
      all = all.filter((one) => one !== before && !(one.repo === repo && one.state !== "waiting"));
      all.push({ id: randomUUID(), repo, pulls, by: login, createdAt: new Date().toISOString(), state: "waiting" });
      await changed();
    });
    return c.json(snapshot());
  });

  routes.delete("/:id", async (c) => {
    const id = c.req.param("id");
    const found = all.find((one) => one.id === id);
    if (!found) {
      throw new Refusal(404, "That pending release is gone already.");
    }
    const { login } = await allowed(c, found.repo);
    await serial(async () => {
      if (found.state === "releasing") {
        throw new Refusal(409, `${found.repo} is being released right now.`);
      }
      if (found.state === "waiting") {
        end(found, "cancelled", `Cancelled by ${login}.`);
      } else {
        // One that ended is forgotten, so the page stops showing it.
        all = all.filter((one) => one !== found);
      }
      await changed();
    });
    return c.json(snapshot());
  });

  return {
    snapshot,
    routes,
    ready,
    onWebhook(kind, payload) {
      if (kind !== "pull_request" || payload.action !== "closed" || !app) {
        return;
      }
      const repo = text(record(payload.repository).full_name);
      const pull = record(payload.pull_request);
      const number = wholeNumber(pull.number);
      if (repo === undefined || number === undefined) {
        return;
      }
      void withPurpose("pending.webhook", () => serial(() => closed(repo, number, mergedOf(pull)))).catch(
        (error: unknown) => {
          console.warn(
            `pending release: webhook not handled: ${error instanceof Error ? error.name : "unknown error"}`,
          );
        },
      );
    },
  };
}

/** How a closed pull request merged, as GitHub's REST API and webhooks give it; nothing if it didn't. */
function mergedOf(pull: Record<string, unknown>): PendingPull["merged"] | undefined {
  if (pull.merged !== true) {
    return undefined;
  }
  const sha = commit(pull.merge_commit_sha);
  const base = text(record(pull.base).ref);
  const at = text(pull.merged_at) ?? new Date().toISOString();
  // A merge GitHub says of without its commit still counts: the release is then of the default branch's head.
  return { at, ...(sha === undefined ? {} : { sha }), ...(base === undefined ? {} : { base }) };
}

/** What `reading` read, or nothing if GitHub answered 404. */
async function absent<T>(reading: Promise<T>): Promise<T | undefined> {
  try {
    return await reading;
  } catch (error) {
    if (error instanceof AppError && error.status === 404) {
      return undefined;
    }
    throw error;
  }
}

function pullUrl(pull: Pick<PendingPull, "repo" | "number">): string {
  return `https://github.com/${pull.repo}/pull/${pull.number}`;
}

function notice(one: PendingRelease, what: string, headline: string, url?: string): Notice {
  const link = url ?? `https://github.com/${one.repo}/releases`;
  return {
    type: "release",
    repo: one.repo,
    headline,
    url: link,
    key: `pending:${one.id}:${what}`,
    text: `${headline}\n${link}`,
  };
}

/** What the file holds, of what still reads as pending releases; nothing when there is no file yet. */
function load(file: string | undefined): PendingRelease[] {
  if (!file) {
    return [];
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    if ((error as { code?: unknown }).code !== "ENOENT") {
      console.warn(`pending releases not read: ${error instanceof Error ? error.name : "unknown error"}`);
    }
    return [];
  }
  return Array.isArray(raw) ? raw.map(pendingRelease).filter((one): one is PendingRelease => one !== undefined) : [];
}
