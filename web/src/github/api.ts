import type { Auth } from "../auth.ts";

const API_ORIGIN = "https://api.github.com";
const PAGE_SIZE = 100;
// GitHub asks for at least a minute when it says "rate limit" without saying how long.
const DEFAULT_BACKOFF_MS = 60_000;
// Enough to read a big account quickly, few enough not to trip GitHub's secondary rate limit.
export const MAX_PARALLEL = 8;

/** An answer from api.github.com that isn't the data asked for. */
export class GitHubError extends Error {
  status: number;
  /** For a rate limit: when GitHub will answer again, in epoch milliseconds. Unset for any other error. */
  retryAt: number | undefined;

  constructor(path: string, status: number, retryAt: number | undefined) {
    super(`GitHub answered ${status} for ${path}`);
    this.name = "GitHubError";
    this.status = status;
    this.retryAt = retryAt;
  }
}

export type Api = {
  /** Reads one JSON document. `path` is relative to api.github.com. */
  get<T>(path: string): Promise<T>;
  /** Reads every page of a list. `key` names the list in answers that wrap it, such as `check_runs`. */
  list<T>(path: string, key?: string): Promise<T[]>;
  /** Sends one GraphQL query, as `sendQuery` does. */
  query(query: string): Promise<QueryAnswer>;
};

export type QueryError = { type?: string; path?: (string | number)[]; message?: string };
/** What GitHub answered a GraphQL query: the data, and what it wouldn't say of single fields. */
export type QueryAnswer = { data: Record<string, unknown>; errors: QueryError[] };

export type ApiOptions = {
  /** How many requests may be under way at once. */
  parallel?: number;
  /** Ends the requests under way and stops new ones. */
  signal?: AbortSignal;
};

export function createApi(auth: Auth, options: ApiOptions = {}): Api {
  const limit = limiter(options.parallel ?? MAX_PARALLEL);

  async function request(path: string): Promise<Response> {
    const response = await limit(() => {
      options.signal?.throwIfAborted();
      // The browser's HTTP cache does the conditional requests: GitHub sends an ETag with `Cache-Control: private,
      // max-age=60`, and `no-cache` makes the browser revalidate each time instead of serving a minute-old copy.
      // An unchanged answer is then a 304, which GitHub doesn't count against the rate limit, and the page still
      // sees a 200 with the cached body.
      return auth.github(path, { cache: "no-cache", ...(options.signal ? { signal: options.signal } : {}) });
    });
    if (!response.ok) {
      throw new GitHubError(path, response.status, await retryAt(response));
    }
    return response;
  }

  return {
    async get<T>(path: string): Promise<T> {
      return (await (await request(path)).json()) as T;
    },

    async list<T>(path: string, key?: string): Promise<T[]> {
      const found: T[] = [];
      let next: string | undefined = withParam(path, "per_page", String(PAGE_SIZE));
      while (next) {
        const response = await request(next);
        const body: unknown = await response.json();
        const page = key ? (body as Record<string, unknown> | null)?.[key] : body;
        if (!Array.isArray(page)) {
          // Counts as GitHub refusing this one read, so the rest of the dashboard still shows.
          throw new GitHubError(path, response.status, undefined);
        }
        found.push(...(page as T[]));
        next = nextPage(response.headers.get("link"));
      }
      return found;
    },

    query: (query) => limit(() => sendQuery(auth, query, options.signal)),
  };
}

/**
 * Sends one GraphQL query. Throws what fails every call (a rate limit, a sign-in GitHub no longer accepts, GitHub in
 * trouble, a failing network); what GitHub wouldn't say of one field comes back in `errors`, beside the rest.
 */
export async function sendQuery(auth: Auth, query: string, signal: AbortSignal | undefined): Promise<QueryAnswer> {
  signal?.throwIfAborted();
  const response = await auth.github("graphql", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) {
    throw new GitHubError("graphql", response.status, await retryAt(response));
  }
  const body = (await response.json().catch(() => undefined)) as { data?: unknown; errors?: unknown } | undefined;
  const errors = Array.isArray(body?.errors) ? (body.errors as QueryError[]) : [];
  // GraphQL's own rate limit is an answer like any other, with the error inside.
  if (errors.some((error) => error?.type === "RATE_LIMITED")) {
    const reset = response.headers.get("x-ratelimit-reset") ?? "";
    const at = /^\d+$/.test(reset) ? Number(reset) * 1000 : 0;
    throw new GitHubError("graphql", 403, Math.max(at, Date.now() + (at ? 1000 : DEFAULT_BACKOFF_MS)));
  }
  const data = body?.data;
  if (typeof data !== "object" || data === null) {
    throw new GitHubError("graphql", 502, undefined);
  }
  return { data: data as Record<string, unknown>, errors };
}

function withParam(path: string, name: string, value: string): string {
  return `${path}${path.includes("?") ? "&" : "?"}${name}=${value}`;
}

/** The address of the next page from a `Link` header, if there is one. */
export function nextPage(link: string | null): string | undefined {
  for (const part of link?.split(",") ?? []) {
    const match = /<([^>]+)>\s*;.*\brel="?next"?/.exec(part);
    // The token goes wherever this points, so it has to be GitHub's API.
    if (match?.[1] && new URL(match[1], API_ORIGIN).origin === API_ORIGIN) {
      return match[1];
    }
  }
  return undefined;
}

/**
 * When to try again if `response` is GitHub's rate limit; undefined if it is any other error. A rate limit is a 429
 * or a 403 (which is also a token without the permission, which isn't one): with `retry-after` (seconds) for a
 * secondary limit, or `x-ratelimit-remaining: 0` and `x-ratelimit-reset` (epoch seconds) for the hourly one.
 */
export async function retryAt(response: Response): Promise<number | undefined> {
  if (response.status !== 403 && response.status !== 429) {
    return undefined;
  }
  const retryAfter = response.headers.get("retry-after") ?? "";
  if (/^\d+$/.test(retryAfter)) {
    return Date.now() + Math.max(Number(retryAfter), 1) * 1000;
  }
  const reset = response.headers.get("x-ratelimit-reset") ?? "";
  if (response.headers.get("x-ratelimit-remaining") === "0") {
    return /^\d+$/.test(reset) ? Math.max(Number(reset) * 1000, Date.now() + 1000) : Date.now() + DEFAULT_BACKOFF_MS;
  }
  if (response.status === 429 || /rate limit/i.test(await response.text().catch(() => ""))) {
    return Date.now() + DEFAULT_BACKOFF_MS;
  }
  return undefined;
}

/** Runs at most `max` tasks at once; the rest wait their turn, first come first served. */
export function limiter(max: number): <T>(task: () => Promise<T>) => Promise<T> {
  let running = 0;
  const waiting: (() => void)[] = [];
  return async (task) => {
    if (running >= max) {
      // The task that finishes hands its place straight to this one, so `running` stays as it is.
      await new Promise<void>((resolve) => waiting.push(resolve));
    } else {
      running++;
    }
    try {
      return await task();
    } finally {
      const next = waiting.shift();
      if (next) {
        next();
      } else {
        running--;
      }
    }
  };
}
