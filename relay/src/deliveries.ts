import { type GitHubApp, reasonOf } from "./github_app.ts";
import { isRecord, text, wholeNumber } from "./payload.ts";
import { type Telemetry, withPurpose } from "./telemetry.ts";

export const DELIVERIES_MS = 60 * 60_000;
// The first read waits a little after the relay starts: long enough not to add to its first reads, and soon enough
// that what GitHub couldn't deliver while it was down (a deploy) is sent again within a minute or so.
export const FIRST_READ_MS = 60_000;
// GitHub keeps deliveries for a few days; more than this many pages back at a time isn't read.
const MAX_PAGES = 10;
// How many delivery ids are remembered as already logged, and guids as already asked to be sent again.
const REMEMBERED = 5000;
// A failed delivery older than this isn't sent again: what it said is stale, and the page's full reads have long
// caught up with it.
export const REDELIVER_WITHIN_MS = 6 * 60 * 60_000;
// At most this many are asked for in one read, so a long outage doesn't flood the relay at once.
const MAX_REDELIVERIES = 100;

/**
 * Watches the app's own webhook delivery log, read soon after the relay starts and then every hour:
 *
 * - With `telemetry`, it logs GitHub's account of each delivery once (`webhook_delivery`): when GitHub sent it, how
 *   long the relay took to answer, its status, and whether it was a redelivery. Joined on the delivery id with the
 *   relay's own `webhook` line, it tells how late webhooks arrive, and which never did.
 * - Each delivery that failed (the relay was down for a deploy, or the proxy in front of it answered an error) and
 *   that no later attempt of the same delivery made up for, it asks GitHub to send again, once. GitHub doesn't do
 *   that by itself, so without this a change it told while the relay was away showed only at the page's next full
 *   read.
 */
export function watchDeliveries(options: {
  app: GitHubApp;
  telemetry?: Telemetry | undefined;
  closing?: AbortSignal | undefined;
  now?: () => number;
}) {
  const { app, telemetry } = options;
  const now = options.now ?? Date.now;
  // By delivery id: each attempt has its own, a redelivery's guid is the first attempt's.
  const logged = new Set<string>();
  // By guid: asked to be sent again.
  const asked = new Set<string>();

  async function read(): Promise<void> {
    // What each read saw, logged once at its end (`webhook_deliveries_read`), so a read that logs nothing says why.
    const seen = { pages: 0, items: 0, logged: 0, skipped: 0, redelivered: 0, reachedLogged: false };
    // The guids of deliveries an attempt got through for. The log is newest first, so a redelivery that worked is
    // seen before the attempt it made up for.
    const through = new Set<string>();
    const failed: { id: string; guid: string }[] = [];
    try {
      let cursor: string | undefined;
      for (let page = 0; page < MAX_PAGES; page++) {
        const { deliveries, next } = await app.deliveries(cursor);
        seen.pages++;
        seen.items += deliveries.length;
        for (const raw of deliveries) {
          const id = isRecord(raw) ? deliveryId(raw.id) : undefined;
          const guid = isRecord(raw) ? text(raw.guid) : undefined;
          if (!isRecord(raw) || id === undefined || guid === undefined) {
            seen.skipped++;
            continue;
          }
          const status = wholeNumber(raw.status_code);
          if (status !== undefined && status >= 200 && status < 300) {
            through.add(guid);
          } else if (!through.has(guid) && !asked.has(guid) && recent(text(raw.delivered_at))) {
            failed.push({ id, guid });
          }
          if (logged.has(id)) {
            seen.reachedLogged = true;
            continue;
          }
          remember(logged, id);
          seen.logged++;
          telemetry?.event("webhook_delivery", {
            delivery: guid,
            kind: text(raw.event),
            action: text(raw.action),
            deliveredAt: text(raw.delivered_at),
            // GitHub gives it in seconds.
            ms: typeof raw.duration === "number" ? Math.round(raw.duration * 1000) : undefined,
            status,
            redelivery: raw.redelivery === true || undefined,
          });
        }
        if (seen.reachedLogged || !next) break;
        cursor = next;
      }
      seen.redelivered = await redeliver(failed, through);
    } finally {
      telemetry?.event("webhook_deliveries_read", { ...seen, reachedLogged: seen.reachedLogged || undefined });
    }
  }

  /** Asks for each failed delivery again, oldest first, as they happened. Gives how many GitHub took. */
  async function redeliver(failed: { id: string; guid: string }[], through: Set<string>): Promise<number> {
    // A guid can fail more than once, and only its newest attempt is asked for again. `failed` is newest first.
    const newest = new Map<string, string>();
    for (const { id, guid } of failed) {
      if (!through.has(guid) && !newest.has(guid)) newest.set(guid, id);
    }
    let taken = 0;
    for (const [guid, id] of [...newest].reverse().slice(0, MAX_REDELIVERIES)) {
      remember(asked, guid);
      try {
        await withPurpose("deliveries.redeliver", () => app.redeliver(id));
        taken++;
        telemetry?.event("webhook_redelivery", { delivery: guid });
      } catch (error) {
        telemetry?.event("webhook_redelivery", { delivery: guid, error: reasonOf(error) });
      }
    }
    return taken;
  }

  function recent(deliveredAt: string | undefined): boolean {
    const at = deliveredAt ? Date.parse(deliveredAt) : Number.NaN;
    return Number.isFinite(at) && now() - at <= REDELIVER_WITHIN_MS;
  }

  function remember(set: Set<string>, key: string): void {
    set.add(key);
    if (set.size > REMEMBERED) {
      const oldest = set.values().next().value;
      if (oldest !== undefined) set.delete(oldest);
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

/** A delivery's id as text: `deliveryPage` gives it so; a small one may still come as a number. */
function deliveryId(value: unknown): string | undefined {
  if (typeof value === "string" && /^\d{1,30}$/.test(value)) return value;
  const number = wholeNumber(value);
  return number === undefined ? undefined : String(number);
}
