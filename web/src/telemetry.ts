import type { Auth } from "./auth.ts";

/**
 * The page's side of the telemetry (see the relay's telemetry.ts): what it asks api.github.com, why, and what came
 * of it, sent to the relay in batches, which logs each event as one line. The page's calls go straight to GitHub and
 * never pass the relay, so this is the only way they are seen.
 *
 * Nothing is recorded until `startTelemetry` runs, which the real page does and tests and the demo don't. A relay
 * with telemetry off answers 404, and the page then stops sending and forgets what it held. Events hold no token,
 * no title or body, nothing a user typed: paths, counts, times and ids.
 */
export type TelemetryFields = Record<string, string | number | boolean | undefined>;

export const FLUSH_MS = 30_000;
// Past this many unsent events the oldest are dropped, so a relay that doesn't answer costs no memory.
const MAX_QUEUED = 1000;
const ENDPOINT = "api/telemetry";

type Sink = (kind: string, fields: TelemetryFields) => void;
let sink: Sink | undefined;

/** Records one event, if the telemetry was started. */
export function record(kind: string, fields: TelemetryFields): void {
  sink?.(kind, fields);
}

export type TelemetryOptions = {
  fetch?: typeof fetch;
  /** `navigator.sendBeacon`, for what is left when the page is hidden or closed. */
  beacon?: (url: string, data: Blob) => boolean;
  flushMs?: number;
};

/** Starts recording and sending; returns how to stop. */
export function startTelemetry(options: TelemetryOptions = {}): () => void {
  const post = options.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const beacon =
    options.beacon ??
    (typeof navigator !== "undefined" && typeof navigator.sendBeacon === "function"
      ? (url: string, data: Blob) => navigator.sendBeacon(url, data)
      : undefined);
  // Which tab an event is from: tabs open at once show as different ids.
  const tab = Math.random().toString(36).slice(2, 10);
  let queue: Record<string, unknown>[] = [];
  let off = false;

  sink = (kind, fields) => {
    if (off) return;
    const event: Record<string, unknown> = { kind, ts: new Date().toISOString() };
    for (const [key, value] of Object.entries(fields)) {
      if (value !== undefined) event[key] = value;
    }
    queue.push(event);
    if (queue.length > MAX_QUEUED) queue.shift();
  };

  function take(): string | undefined {
    if (queue.length === 0 || off) return undefined;
    const body = JSON.stringify({ tab, events: queue });
    queue = [];
    return body;
  }

  async function flush(): Promise<void> {
    const body = take();
    if (!body) return;
    try {
      const response = await post(ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        keepalive: true,
      });
      if (response.status === 404) {
        // The relay doesn't take them: nothing more is recorded.
        off = true;
        queue = [];
      }
    } catch {
      // Lost, then; the next batch tries again.
    }
  }

  function onVisibility(): void {
    const visible = !document.hidden;
    record("visibility", { visible });
    if (!visible) {
      // The page may not come back: what is left goes now, the way that survives closing.
      const body = take();
      if (body && beacon) {
        beacon(ENDPOINT, new Blob([body], { type: "application/json" }));
      } else if (body) {
        void post(ENDPOINT, { method: "POST", body, keepalive: true }).catch(() => {});
      }
    }
  }

  const timer = setInterval(() => void flush(), options.flushMs ?? FLUSH_MS);
  if (typeof document !== "undefined") document.addEventListener("visibilitychange", onVisibility);
  recordLoad();

  return () => {
    clearInterval(timer);
    if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onVisibility);
    void flush();
    sink = undefined;
  };
}

/** How long the page took to load, from the browser's own timing of it. */
function recordLoad(): void {
  const navigation =
    typeof performance !== "undefined" && typeof performance.getEntriesByType === "function"
      ? (performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined)
      : undefined;
  record("load", {
    domReadyMs: navigation ? Math.round(navigation.domContentLoadedEventEnd) : undefined,
    visible: typeof document !== "undefined" ? !document.hidden : undefined,
  });
}

/** Milliseconds since the page started loading. */
export function sinceLoad(): number {
  return Math.round(performance.now());
}

const PURPOSE = Symbol("purpose");
type Labelled = RequestInit & { [PURPOSE]?: string };

/**
 * `auth`, with every call it makes to api.github.com recorded as made for `purpose`, such as `read.everything`:
 * what made the page ask, which the path alone doesn't say.
 */
export function labelled(auth: Auth, purpose: string): Auth {
  return {
    ...auth,
    github: (path, init) => auth.github(path, { ...init, [PURPOSE]: purpose } as Labelled),
  };
}

// The last ETag seen per path, to tell an answer that didn't change: the browser hides GitHub's 304 behind a 200.
const etags = new Map<string, string>();
const MAX_ETAGS = 500;

/** Sends one request to api.github.com with `send`, and records it. */
export async function recorded(
  path: string,
  init: RequestInit | undefined,
  send: () => Promise<Response>,
): Promise<Response> {
  if (!sink) return send();
  const method = (init?.method ?? "GET").toUpperCase();
  const purpose = (init as Labelled | undefined)?.[PURPOSE];
  const clean = `/${(path.split("?")[0] ?? "").replace(/^\//, "")}`;
  const started = performance.now();
  let response: Response;
  try {
    response = await send();
  } catch (error) {
    record("request", {
      method,
      path: clean,
      purpose,
      error: error instanceof Error ? error.name : "failed",
      ms: Math.round(performance.now() - started),
    });
    throw error;
  }
  const headers = response.headers;
  let unchanged: boolean | undefined;
  const etag = headers.get("etag");
  if (method === "GET" && etag && response.ok) {
    unchanged = etags.get(path) === etag;
    etags.delete(path);
    etags.set(path, etag);
    const oldest = etags.keys().next().value;
    if (etags.size > MAX_ETAGS && oldest !== undefined) etags.delete(oldest);
  }
  record("request", {
    method,
    path: clean,
    purpose,
    status: response.status,
    ms: Math.round(performance.now() - started),
    bytes: number(headers.get("content-length")),
    rateResource: headers.get("x-ratelimit-resource") ?? undefined,
    rateRemaining: number(headers.get("x-ratelimit-remaining")),
    rateUsed: number(headers.get("x-ratelimit-used")),
    unchanged,
  });
  return response;
}

function number(value: string | null): number | undefined {
  return value !== null && /^\d+$/.test(value) ? Number(value) : undefined;
}
