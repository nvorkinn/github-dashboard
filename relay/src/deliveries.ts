import { type GitHubApp, reasonOf } from "./github_app.ts";
import { isRecord, text, wholeNumber } from "./payload.ts";
import { type Telemetry, withPurpose } from "./telemetry.ts";

export const DELIVERIES_MS = 60 * 60_000;
// The first read waits a little, so it doesn't add to the reads of a relay that just started.
export const FIRST_READ_MS = 60_000;
// GitHub keeps deliveries for a few days; more than this many pages back at a time isn't read.
const MAX_PAGES = 10;
// How many deliveries are remembered as already logged.
const REMEMBERED = 5000;

/**
 * Logs GitHub's own account of each webhook delivery once (`webhook_delivery`), read every hour from the app's
 * delivery log: when GitHub sent it, how long the relay took to answer, its status, and whether it was a redelivery.
 * Joined on the delivery id with the relay's own `webhook` line, it tells how late webhooks arrive, and which never
 * did. Only for telemetry: nothing else reads it.
 */
export function logDeliveries(options: { app: GitHubApp; telemetry: Telemetry; closing?: AbortSignal | undefined }) {
  const { app, telemetry } = options;
  // Known by their guid: GitHub's numeric `id` has outgrown what a JSON number holds exactly, so no number is kept.
  const logged = new Set<string>();

  async function read(): Promise<void> {
    let cursor: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const { deliveries, next } = await app.deliveries(cursor);
      let reachedLogged = false;
      for (const raw of deliveries) {
        const guid = isRecord(raw) ? text(raw.guid) : undefined;
        if (!isRecord(raw) || guid === undefined) continue;
        if (logged.has(guid)) {
          reachedLogged = true;
          continue;
        }
        remember(guid);
        telemetry.event("webhook_delivery", {
          delivery: guid,
          kind: text(raw.event),
          action: text(raw.action),
          deliveredAt: text(raw.delivered_at),
          // GitHub gives it in seconds.
          ms: typeof raw.duration === "number" ? Math.round(raw.duration * 1000) : undefined,
          status: wholeNumber(raw.status_code),
          redelivery: raw.redelivery === true || undefined,
        });
      }
      if (reachedLogged || !next) return;
      cursor = next;
    }
  }

  function remember(guid: string): void {
    logged.add(guid);
    if (logged.size > REMEMBERED) {
      const oldest = logged.values().next().value;
      if (oldest !== undefined) logged.delete(oldest);
    }
  }

  const once = () =>
    void withPurpose("deliveries.hourly", read).catch((error: unknown) => {
      console.warn(`webhook deliveries not read: ${reasonOf(error)}`);
    });

  if (options.closing?.aborted) return;
  const first = setTimeout(once, FIRST_READ_MS);
  const again = setInterval(once, DELIVERIES_MS);
  first.unref();
  again.unref();
  options.closing?.addEventListener("abort", () => {
    clearTimeout(first);
    clearInterval(again);
  });
}
