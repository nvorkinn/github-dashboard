import { createSign } from "node:crypto";
import type { AppConfig } from "./config.ts";
import { isRecord, text, wholeNumber } from "./payload.ts";

const API = "https://api.github.com";
const TIMEOUT_MS = 10_000;
const PER_PAGE = 100;
// No list the relay reads is longer than this many pages; one that would be is cut off there.
const MAX_PAGES = 10;
// GitHub takes an app's token for at most ten minutes, and allows for clocks a minute apart.
const JWT_SECONDS = 9 * 60;
const CLOCK_DRIFT_SECONDS = 60;
// An installation token lasts an hour; a new one is asked for when this little of it is left.
const TOKEN_MARGIN_MS = 5 * 60_000;

/** GitHub said no, or didn't answer. Carries the status (0 for no answer) and nothing of the request. */
export class AppError extends Error {
  status: number;

  constructor(status: number, reason: string) {
    super(reason);
    this.name = "AppError";
    this.status = status;
  }
}

/** Why a read failed, for a log: the status or the kind of failure, never a token or an answer's body. */
export function reasonOf(error: unknown): string {
  return error instanceof AppError ? error.message : error instanceof Error ? error.name : "request failed";
}

/** A repository an installation of the app reaches. */
export type InstalledRepo = { repo: string; installation: number; defaultBranch: string | undefined };

/**
 * Reads api.github.com as the GitHub App: as one of its installations, with that installation's token. A token is
 * asked for with the app's private key, lasts an hour and is held in memory only, until shortly before it ends.
 * Everything here reads; the relay writes nothing to GitHub.
 */
export type GitHubApp = {
  /** Every repository the app's installations reach, archived ones left out. */
  repositories(): Promise<InstalledRepo[]>;
  /** `GET <path>` as the installation. Throws an `AppError`; 404 is one like any other. */
  get<T>(installation: number, path: string): Promise<T>;
  /** Every page of a list: an array, or the array under `key` of an object. */
  list<T>(installation: number, path: string, key?: string): Promise<T[]>;
};

export function createGitHubApp(options: { config: AppConfig; fetch?: typeof fetch; now?: () => number }): GitHubApp {
  const { config } = options;
  const fetcher = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  // Per installation: its token and when it ends, or the asking for one that is under way.
  const tokens = new Map<number, Promise<{ token: string; expiresAt: number }>>();

  function appToken(): string {
    const seconds = Math.floor(now() / 1000);
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const unsigned = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({
      iat: seconds - CLOCK_DRIFT_SECONDS,
      exp: seconds + JWT_SECONDS,
      iss: config.appId,
    })}`;
    return `${unsigned}.${createSign("RSA-SHA256").update(unsigned).sign(config.privateKey, "base64url")}`;
  }

  async function request(method: string, path: string, token: string): Promise<unknown> {
    let response: Response;
    try {
      response = await fetcher(`${API}/${path}`, {
        method,
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "github-dashboard-relay",
        },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (error) {
      // Only the kind of failure: a message could quote the request.
      throw new AppError(0, error instanceof Error ? error.name : "request failed");
    }
    if (!response.ok) {
      // The answer isn't needed, so it is dropped unread, which frees the connection.
      await response.body?.cancel().catch(() => {});
      throw new AppError(response.status, `HTTP ${response.status}`);
    }
    try {
      return await response.json();
    } catch {
      throw new AppError(502, "not JSON");
    }
  }

  async function installationToken(installation: number): Promise<string> {
    const kept = tokens.get(installation);
    if (kept) {
      const one = await kept.catch(() => undefined);
      if (one && one.expiresAt - now() > TOKEN_MARGIN_MS) {
        return one.token;
      }
      // Asked for again meanwhile, by another read of the same installation: that one's answer will do.
      if (tokens.get(installation) !== kept) {
        return installationToken(installation);
      }
    }
    const fresh = request("POST", `app/installations/${installation}/access_tokens`, appToken()).then((answer) => {
      const token = isRecord(answer) && typeof answer.token === "string" ? answer.token : undefined;
      const expiresAt = isRecord(answer) ? Date.parse(String(answer.expires_at)) : Number.NaN;
      if (!token) {
        throw new AppError(502, "no token in the answer");
      }
      return { token, expiresAt: Number.isFinite(expiresAt) ? expiresAt : now() + TOKEN_MARGIN_MS * 2 };
    });
    tokens.set(installation, fresh);
    try {
      return (await fresh).token;
    } catch (error) {
      // Not kept when it failed: it's asked again on the next read.
      if (tokens.get(installation) === fresh) {
        tokens.delete(installation);
      }
      throw error;
    }
  }

  async function get<T>(installation: number, path: string): Promise<T> {
    const token = await installationToken(installation);
    try {
      return (await request("GET", path, token)) as T;
    } catch (error) {
      if (!(error instanceof AppError) || error.status !== 401) {
        throw error;
      }
      // A token GitHub no longer takes, such as after the app was suspended and let back: once more with a new one.
      tokens.delete(installation);
      return (await request("GET", path, await installationToken(installation))) as T;
    }
  }

  async function pages<T>(read: (path: string) => Promise<unknown>, path: string, key?: string): Promise<T[]> {
    const all: T[] = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const answer = await read(`${path}${path.includes("?") ? "&" : "?"}per_page=${PER_PAGE}&page=${page}`);
      const items = key === undefined ? answer : isRecord(answer) ? answer[key] : undefined;
      if (!Array.isArray(items)) {
        throw new AppError(502, "not a list");
      }
      all.push(...(items as T[]));
      if (items.length < PER_PAGE) {
        break;
      }
    }
    return all;
  }

  return {
    get,
    list: (installation, path, key) => pages((one) => get(installation, one), path, key),

    async repositories() {
      const installations = await pages<unknown>((path) => request("GET", path, appToken()), "app/installations");
      const found: InstalledRepo[] = [];
      for (const one of installations) {
        const installation = isRecord(one) ? wholeNumber(one.id) : undefined;
        // A suspended installation gives no token.
        if (installation === undefined || (isRecord(one) && one.suspended_at)) {
          continue;
        }
        const repos = await pages<unknown>(
          (path) => get(installation, path),
          "installation/repositories",
          "repositories",
        );
        for (const raw of repos) {
          const repo = isRecord(raw) ? text(raw.full_name) : undefined;
          if (repo !== undefined && isRecord(raw) && raw.archived !== true) {
            found.push({ repo, installation, defaultBranch: text(raw.default_branch) });
          }
        }
      }
      return found;
    },
  };
}
