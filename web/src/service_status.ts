import type { StatusSnapshot } from "../../shared/status.ts";

export const STATUS_POLL_MS = 60_000;
export type ServiceStatusState = StatusSnapshot & { loading: boolean };

/** Shared by all status surfaces; only one request and timer run while there are subscribers. */
export function createServiceStatus(options: { fetch?: typeof fetch; now?: () => number } = {}) {
  const fetcher = options.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const now = options.now ?? Date.now;
  const listeners = new Set<() => void>();
  let state: ServiceStatusState = { loading: true, stale: true };
  let timer: ReturnType<typeof setTimeout> | undefined;
  let controller: AbortController | undefined;
  let pending: Promise<void> | undefined;
  let nextRead = 0;

  function publish(next: ServiceStatusState) {
    state = next;
    for (const listener of listeners) listener();
  }
  function schedule() {
    clearTimeout(timer);
    if (listeners.size) timer = setTimeout(() => void refresh(), Math.max(0, nextRead - now()));
  }
  function refresh(): Promise<void> {
    if (pending) return pending;
    const request = new AbortController();
    controller = request;
    publish({
      ...state,
      loading: true,
      stale: state.stale || (state.fetchedAt !== undefined && now() - state.fetchedAt >= STATUS_POLL_MS * 2),
    });
    pending = (async () => {
      try {
        const response = await fetcher("api/github/status", {
          signal: AbortSignal.any([request.signal, AbortSignal.timeout(15_000)]),
          cache: "no-store",
        });
        if (!response.ok) throw new Error("Status unavailable");
        const snapshot = (await response.json()) as StatusSnapshot;
        if (!snapshot.data || !Number.isFinite(snapshot.fetchedAt)) throw new Error("Invalid status response");
        if (request.signal.aborted) return;
        publish({
          ...snapshot,
          loading: false,
          stale: snapshot.stale || now() - (snapshot.fetchedAt ?? 0) >= STATUS_POLL_MS * 2,
        });
      } catch {
        if (!request.signal.aborted)
          publish({ ...state, loading: false, stale: true, error: "Can't refresh GitHub status." });
      } finally {
        pending = undefined;
        controller = undefined;
        nextRead = request.signal.aborted ? 0 : now() + STATUS_POLL_MS;
        schedule();
      }
    })();
    return pending;
  }

  return {
    state: () => state,
    refresh,
    subscribe(listener: () => void) {
      listeners.add(listener);
      if (now() >= nextRead) void refresh();
      else schedule();
      return () => {
        listeners.delete(listener);
        if (!listeners.size) {
          clearTimeout(timer);
          controller?.abort();
          // A resumed view should revalidate immediately after an interrupted request.
          if (controller) nextRead = 0;
        }
      };
    },
  };
}

export const serviceStatus = createServiceStatus();
