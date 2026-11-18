import { createAppAuth } from "@octokit/auth-app";
import { request as octokitRequest } from "@octokit/request";
import type { AppConfig } from "./config.ts";
import { isRecord, text, wholeNumber } from "./payload.ts";
import { currentPurpose, type Telemetry } from "./telemetry.ts";

const API = "https://api.github.com";
const TIMEOUT_MS = 10_000;
const PER_PAGE = 100;
// No list the relay reads is longer than this many pages; one that would be is cut off there.
const MAX_PAGES = 10;
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
export type InstalledRepo = {
  repo: string;
  installation: number;
  defaultBranch: string | undefined;
  /** When anything was last pushed to it, to any branch. */
  pushedAt?: string | undefined;
};

/**
 * Reads api.github.com as the GitHub App: as one of its installations, with that installation's token. Octokit
 * (`@octokit/auth-app`) makes the tokens from the app's ID and private key: it signs the app's own short-lived token,
 * trades it for an installation's, which lasts an hour, and keeps that in memory until shortly before it ends.
 * Everything here reads, GraphQL queries included; the relay writes nothing to GitHub.
 */
export type GitHubApp = {
  /** Every repository the app's installations reach, archived ones left out. */
  repositories(): Promise<InstalledRepo[]>;
  /** `GET <path>` as the installation. Throws an `AppError`; 404 is one like any other. */
  get<T>(installation: number, path: string): Promise<T>;
  /** Every page of a list: an array, or the array under `key` of an object. */
  list<T>(installation: number, path: string, key?: string): Promise<T[]>;
  /**
   * One GraphQL query as the installation. What GitHub wouldn't say of single fields comes back in `errors`, beside
   * the rest; an answer without data throws an `AppError`.
   */
  query(installation: number, query: string, variables?: Record<string, unknown>): Promise<GraphQLAnswer>;
  /**
   * One page of the app's webhook deliveries, newest first, as the app itself: what GitHub says it sent, when and how
   * it went. `cursor` is the `next` of the page before.
   */
  deliveries(cursor?: string): Promise<{ deliveries: unknown[]; next: string | undefined }>;
};

export type GraphQLAnswer = { data: Record<string, unknown>; errors: { type?: string; path?: unknown[] }[] };

/**
 * With `telemetry`, a GraphQL query that asks for `rateLimit { cost remaining }` has what GitHub said of it logged
 * (`graphql_cost`), and taken out of the answer.
 */
export function createGitHubApp(options: {
  config: AppConfig;
  fetch?: typeof fetch;
  telemetry?: Telemetry | undefined;
}): GitHubApp {
  const { config } = options;
  const fetcher = options.fetch ?? fetch;
  const auth = createAppAuth({
    appId: config.appId,
    privateKey: config.privateKey,
    // Octokit asks GitHub for the tokens through the same `fetch` as every other read, and gives up as soon.
    request: octokitRequest.defaults({
      headers: { "user-agent": "github-dashboard-relay" },
      request: {
        fetch: (url: string | URL | Request, init?: RequestInit) =>
          fetcher(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) }),
      },
    }),
  });

  /** A token from Octokit; a failure to get one is said by its status or kind and nothing else. */
  async function token(asking: Promise<{ token: string }>): Promise<string> {
    try {
      return (await asking).token;
    } catch (error) {
      const status = (error as { status?: unknown } | null)?.status;
      // Only the status or the kind of failure: a message could quote the request.
      throw typeof status === "number" && status > 0
        ? new AppError(status, `HTTP ${status}`)
        : new AppError(0, error instanceof Error ? error.name : "request failed");
    }
  }

  const appToken = () => token(auth({ type: "app" }));
  /** The installation's token: the one Octokit keeps, or with `fresh` a new one. */
  const installationToken = (installation: number, fresh = false) =>
    token(auth({ type: "installation", installationId: installation, refresh: fresh }));

  async function request(method: string, path: string, bearer: string, body?: unknown): Promise<unknown> {
    let response: Response;
    try {
      response = await fetcher(`${API}/${path}`, {
        method,
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${bearer}`,
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "github-dashboard-relay",
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
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

  async function asInstallation(installation: number, method: string, path: string, body?: unknown): Promise<unknown> {
    try {
      return await request(method, path, await installationToken(installation), body);
    } catch (error) {
      if (!(error instanceof AppError) || error.status !== 401) {
        throw error;
      }
      // A token GitHub no longer takes, such as after the app was suspended and let back: once more with a new one.
      return await request(method, path, await installationToken(installation, true), body);
    }
  }

  const get = async <T>(installation: number, path: string) => (await asInstallation(installation, "GET", path)) as T;

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

    async query(installation, query, variables) {
      const answer = await asInstallation(installation, "POST", "graphql", { query, variables: variables ?? {} });
      if (!isRecord(answer) || !isRecord(answer.data)) {
        throw new AppError(502, "no data");
      }
      const errors = Array.isArray(answer.errors) ? answer.errors.filter(isRecord) : [];
      const { rateLimit, ...data } = answer.data;
      if (isRecord(rateLimit)) {
        options.telemetry?.event("graphql_cost", {
          purpose: currentPurpose(),
          cost: wholeNumber(rateLimit.cost),
          remaining: wholeNumber(rateLimit.remaining),
        });
      }
      return { data, errors: errors as GraphQLAnswer["errors"] };
    },

    async deliveries(cursor) {
      const path = `app/hook/deliveries?per_page=${PER_PAGE}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
      let response: Response;
      try {
        response = await fetcher(`${API}/${path}`, {
          headers: {
            Accept: "application/vnd.github+json",
            Authorization: `Bearer ${await appToken()}`,
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "github-dashboard-relay",
          },
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
      } catch (error) {
        throw new AppError(0, error instanceof Error ? error.name : "request failed");
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        throw new AppError(response.status, `HTTP ${response.status}`);
      }
      const page: unknown = await response.json().catch(() => undefined);
      if (!Array.isArray(page)) {
        throw new AppError(502, "not a list");
      }
      const link = /<([^>]+)>;\s*rel="next"/.exec(response.headers.get("link") ?? "")?.[1];
      const next = link ? (new URL(link).searchParams.get("cursor") ?? undefined) : undefined;
      return { deliveries: page, next };
    },

    async repositories() {
      const installations = await pages<unknown>(
        async (path) => request("GET", path, await appToken()),
        "app/installations",
      );
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
            found.push({ repo, installation, defaultBranch: text(raw.default_branch), pushedAt: text(raw.pushed_at) });
          }
        }
      }
      return found;
    },
  };
}
