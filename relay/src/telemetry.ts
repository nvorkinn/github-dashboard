import type { MiddlewareHandler } from "hono";

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
  /** `fetch` that logs each request it sends. */
  outbound(fetcher: typeof fetch): typeof fetch;
};

export type TelemetryOptions = {
  /** Where a line goes; stdout by default. */
  write?: (line: string) => void;
  now?: () => number;
};

/** Whether the relay logs its calls: on unless `TELEMETRY` says `off`. */
export function telemetryEnabled(env: Record<string, string | undefined>): boolean {
  return !/^(off|false|0|no)$/i.test(env.TELEMETRY?.trim() ?? "");
}

// The docker health check asks every 30 seconds, which says nothing about reading GitHub.
const QUIET_PATHS = new Set(["/healthz"]);

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
        const fields = { method, host: url.host, path: cleanPath(url) };
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
  };
}

/** The path without its query, and without Telegram's bot token, which Telegram puts in it. */
function cleanPath(url: URL): string {
  return url.pathname.replace(/^\/bot[^/]+/, "/bot*");
}

function size(value: string | null): number | undefined {
  return value !== null && /^\d+$/.test(value) ? Number(value) : undefined;
}
