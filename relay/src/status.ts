import { parseServiceSummary, type StatusSnapshot } from "../../shared/status.ts";

export const STATUS_CACHE_MS = 60_000;
const STATUS_URL = "https://www.githubstatus.com/api/v2/summary.json";

/** One shared, on-demand public cache per relay. Failed reads retain the last success and back off too. */
export function createStatusCache(options: { fetch: typeof fetch; now?: () => number }) {
  const now = options.now ?? Date.now;
  let snapshot: StatusSnapshot = { stale: true };
  let nextRead = 0;
  let pending: Promise<StatusSnapshot> | undefined;

  return function read(): Promise<StatusSnapshot> {
    if (pending) return pending;
    if (now() < nextRead) return Promise.resolve(snapshot);
    pending = (async () => {
      try {
        const response = await options.fetch(STATUS_URL, {
          signal: AbortSignal.timeout(10_000),
          headers: { Accept: "application/json" },
          cache: "no-cache",
        });
        if (!response.ok) throw new Error("Status upstream unavailable");
        const data = parseServiceSummary(await response.json());
        snapshot = { data, fetchedAt: now(), stale: false };
      } catch {
        snapshot = { ...snapshot, stale: true, error: "Can't refresh GitHub status." };
      } finally {
        nextRead = now() + STATUS_CACHE_MS;
        pending = undefined;
      }
      return snapshot;
    })();
    return pending;
  };
}
