import type { Context } from "hono";

/**
 * What an open page is told about a webhook: that something changed, and just enough to know what to fetch again.
 * The page gets the content itself from api.github.com with its own token, so nothing here is worth protecting
 * beyond what the reverse proxy already does, and nothing else from the webhook's payload is passed on.
 */
export type Change = {
  /** The webhook's event name, such as `pull_request` or `workflow_run`. */
  kind: string;
  /** The repository's full name, `owner/name`. */
  repo?: string;
  action?: string;
  /** The number of the pull request this is about. */
  pull?: number;
  /** The head commit this is about. */
  sha?: string;
  /** The id of the workflow run this is about. */
  run?: number;
};

/** Passes changes from the webhook endpoint to the event streams that are open at that moment. */
export type Hub = {
  /** Hands a change to everyone listening now. With nobody listening it is dropped: nothing is kept for later. */
  publish(change: Change): void;
  /** Starts listening. The function returned stops it; calling that twice does no harm. */
  subscribe(listener: (change: Change) => void): () => void;
  /** How many are listening now. */
  listeners(): number;
  /**
   * When the last listener left (`Date.now()`), or the hub was made if nobody has listened yet; nothing while
   * someone listens. The Telegram notices use it to stay quiet while a page is open and just after.
   */
  idleSince(): number | undefined;
};

export function createHub(): Hub {
  // One entry per call to subscribe, so the same function subscribed twice is two listeners.
  const listeners = new Set<{ listener: (change: Change) => void }>();
  // A restart counts as everyone having just left: open pages connect again within seconds.
  let idleSince: number | undefined = Date.now();
  return {
    publish(change) {
      for (const entry of [...listeners]) {
        try {
          entry.listener(change);
        } catch {
          // One listener failing must not keep the change from the others.
        }
      }
    },
    subscribe(listener) {
      const entry = { listener };
      listeners.add(entry);
      idleSince = undefined;
      return () => {
        if (listeners.delete(entry) && listeners.size === 0) {
          idleSince = Date.now();
        }
      };
    },
    listeners: () => listeners.size,
    idleSince: () => idleSince,
  };
}

// A page that stops reading (a sleeping laptop behind a proxy that keeps the connection) would otherwise have its
// events pile up here. Past this many unread ones its stream is closed; the browser connects again when it is back.
const MAX_UNREAD = 256;

/**
 * `GET /api/events`: the stream of changes for one open page, as Server-Sent Events. It sends `hello` on connecting,
 * `change` for each change published while it is open, and a comment line every `pingMs` so proxies keep the
 * connection. A page that connects later learns nothing of what it missed; it reads the state from api.github.com.
 *
 * The stream ends when the client goes away or `closing` fires, and then leaves no listener or timer behind.
 */
export function eventStream(options: { hub: Hub; pingMs: number; closing?: AbortSignal | undefined }) {
  const encoder = new TextEncoder();

  return (c: Context) => {
    const gone = c.req.raw.signal;
    let stop = () => {};

    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        let open = true;

        const send = (text: string) => {
          if (!open) {
            return;
          }
          if ((controller.desiredSize ?? 0) < -MAX_UNREAD) {
            stop();
            return;
          }
          controller.enqueue(encoder.encode(text));
        };

        const unsubscribe = options.hub.subscribe((change) =>
          send(`event: change\ndata: ${JSON.stringify(change)}\n\n`),
        );
        const ping = setInterval(() => send(": ping\n\n"), options.pingMs);

        stop = () => {
          if (!open) {
            return;
          }
          open = false;
          unsubscribe();
          clearInterval(ping);
          gone.removeEventListener("abort", stop);
          options.closing?.removeEventListener("abort", stop);
          try {
            controller.close();
          } catch {
            // Already closed from the reader's side.
          }
        };

        gone.addEventListener("abort", stop);
        options.closing?.addEventListener("abort", stop);

        send("event: hello\ndata: {}\n\n");
        if (gone.aborted || options.closing?.aborted) {
          stop();
        }
      },
      cancel() {
        stop();
      },
    });

    return c.body(body, 200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-store",
      // Tells nginx-style proxies to pass each event on as it comes instead of collecting them.
      "X-Accel-Buffering": "no",
    });
  };
}
