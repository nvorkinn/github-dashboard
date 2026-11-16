import { AsyncLocalStorage } from "node:async_hooks";
import type { Context, MiddlewareHandler } from "hono";

/**
 * One line of JSON per request the relay answers and per request it sends, on stdout, where the deploy's log
 * collector picks them up. They are there to measure how the dashboard reads GitHub: which calls, how often, how
 * long they take and how much of the rate limit they use. Every line has `telemetry` set to what kind of line it is,
 * so the lines are easy to tell from the relay's other output.
 *
 * Nothing secret goes in a line: no query strings (the sign-in callback's has GitHub's code), no headers but the
 * rate-limit ones, no bodies, and Telegram's bot token is cut out of its path.
 */
export type Telemetry = {
  /** Logs each request the relay answers, other than the health check. */
  inbound: MiddlewareHandler;
  /** `fetch` that logs each request it sends, with the purpose it was sent for (see `withPurpose`). */
  outbound(fetcher: typeof fetch): typeof fetch;
  /** Logs one event of `kind`, such as a webhook arriving; fields that are undefined are left out. */
  event(kind: string, fields: Record<string, unknown>): void;
};

const purposes = new AsyncLocalStorage<string>();

/**
 * Runs `work` with every request it sends, also later on in promises it starts, logged as being for `purpose`, such
 * as `runs.recheck`: what made the relay ask, which the path alone doesn't say. The innermost purpose counts.
 */
export function withPurpose<T>(purpose: string, work: () => T): T {
  return purposes.run(purpose, work);
}

/** The purpose that the requests sent from here are for, if any. */
export function currentPurpose(): string | undefined {
  return purposes.getStore();
}

export type TelemetryOptions = {
  /** Where a line goes; stdout by default. */
  write?: (line: string) => void;
  now?: () => number;
};

/** Whether the relay logs its calls: on unless `TELEMETRY` says `off`. */
export function telemetryEnabled(env: Record<string, string | undefined>): boolean {
  return !/^(off|false|0|no)$/i.test(env.TELEMETRY?.trim() ?? "");
}

// The docker health check asks every 30 seconds, which says nothing about reading GitHub; the page's own telemetry
// is logged event by event (see `pageEvents`).
const QUIET_PATHS = new Set(["/healthz", "/api/telemetry"]);

export function createTelemetry(options: TelemetryOptions = {}): Telemetry {
  const write = options.write ?? ((line: string) => process.stdout.write(`${line}\n`));
  const now = options.now ?? (() => performance.now());

  function log(kind: string, fields: Record<string, unknown>): void {
    const line: Record<string, unknown> = { telemetry: kind, ts: new Date().toISOString() };
    for (const [key, value] of Object.entries(fields)) {
      if (value !== undefined) line[key] = value;
    }
    write(JSON.stringify(line));
  }

  return {
    async inbound(c, next) {
      const path = new URL(c.req.url).pathname;
      if (QUIET_PATHS.has(path)) {
        await next();
        return;
      }
      const started = now();
      let failed = false;
      try {
        await next();
      } catch (error) {
        failed = true;
        throw error;
      } finally {
        log("http_in", {
          method: c.req.method,
          path,
          // A stream answers as soon as it opens, so for /api/events this is the time to open it.
          status: failed ? 500 : c.res.status,
          ms: Math.round(now() - started),
          bytes: size(c.res.headers.get("content-length")),
        });
      }
    },

    outbound(fetcher) {
      return async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : input);
        const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
        const started = now();
        const fields = { method, host: url.host, path: cleanPath(url), purpose: purposes.getStore() };
        let response: Response;
        try {
          response = await fetcher(input, init);
        } catch (error) {
          log("http_out", {
            ...fields,
            error: error instanceof Error ? error.name : "failed",
            ms: Math.round(now() - started),
          });
          throw error;
        }
        const headers = response.headers;
        log("http_out", {
          ...fields,
          status: response.status,
          ms: Math.round(now() - started),
          bytes: size(headers.get("content-length")),
          rateResource: headers.get("x-ratelimit-resource") ?? undefined,
          rateRemaining: size(headers.get("x-ratelimit-remaining")),
          rateUsed: size(headers.get("x-ratelimit-used")),
        });
        return response;
      };
    },

    event: log,
  };
}

/** The path without its query, and without Telegram's bot token, which Telegram puts in it. */
function cleanPath(url: URL): string {
  return url.pathname.replace(/^\/bot[^/]+/, "/bot*");
}

function size(value: string | null): number | undefined {
  return value !== null && /^\d+$/.test(value) ? Number(value) : undefined;
}

/** The kinds of event a page sends (web/src/telemetry.ts); any other is dropped. */
const PAGE_KINDS = new Set(["request", "read", "change_shown", "stream", "load", "visibility"]);
const MAX_PAGE_BODY = 512 * 1024;
const MAX_PAGE_EVENTS = 1000;
const MAX_FIELDS = 24;
const MAX_TEXT = 200;
const FIELD = /^[a-zA-Z]{1,32}$/;
const TAB = /^[a-z0-9]{1,16}$/;

/**
 * `POST /api/telemetry`: a batch of a page's events, `{"tab": "...", "events": [{"kind": "...", "ts": "...", ...}]}`,
 * each logged as its own line, `"telemetry":"page_<kind>"`, with the tab, the time the page gave as `at`, and its
 * other fields. A field is kept only if it has a plain name and holds a number, a yes or no, or a short text, so a
 * page can't make the log say much else; the endpoint sits behind the same sign-in as the page. Without `telemetry`
 * it answers 404, which tells the page to stop sending.
 */
export function pageEvents(telemetry: Telemetry | undefined) {
  return async (c: Context) => {
    if (!telemetry) {
      return c.body(null, 404);
    }
    const text = await c.req.text().catch(() => "");
    if (text.length > MAX_PAGE_BODY) {
      return c.body(null, 413);
    }
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return c.body(null, 400);
    }
    const { tab, events } = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
    if (typeof tab !== "string" || !TAB.test(tab) || !Array.isArray(events)) {
      return c.body(null, 400);
    }
    for (const event of events.slice(0, MAX_PAGE_EVENTS)) {
      if (typeof event !== "object" || event === null) continue;
      const { kind, ts, ...rest } = event as Record<string, unknown>;
      if (typeof kind !== "string" || !PAGE_KINDS.has(kind)) continue;
      const fields: Record<string, unknown> = {
        tab,
        at: typeof ts === "string" && ts.length <= 40 ? ts : undefined,
      };
      for (const [key, value] of Object.entries(rest).slice(0, MAX_FIELDS)) {
        if (!FIELD.test(key) || key === "telemetry" || key === "tab" || key === "at") continue;
        if (typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) {
          fields[key] = value;
        } else if (typeof value === "string") {
          fields[key] = value.slice(0, MAX_TEXT);
        }
      }
      telemetry.event(`page_${kind}`, fields);
    }
    c.header("Cache-Control", "no-store");
    return c.body(null, 204);
  };
}
