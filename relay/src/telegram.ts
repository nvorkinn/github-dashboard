import type { TelegramConfig } from "./config.ts";
import type { Hub } from "./events.ts";
import type { Notice } from "./notices.ts";
import { noticeFrom } from "./notices.ts";
import type { OnWebhook } from "./webhook.ts";

const API = "https://api.telegram.org";
const TIMEOUT_MS = 10_000;
/** How long after the last page leaves the notices stay quiet, so a reload or a brief reconnect sends nothing. */
export const QUIET_MS = 30_000;
/** At most this many notices are remembered as sent. */
export const MAX_SENT = 500;
/** And none for longer than this. */
export const SENT_MS = 24 * 60 * 60 * 1000;

/**
 * Sends a notice to the Telegram chat for each webhook that needs attention (see notices.ts), while nobody is
 * watching the dashboard: only when no page has been connected to /api/events for the last `QUIET_MS`. An open
 * page shows the same thing already.
 *
 * Sending is best-effort: it never holds up or fails the webhook's answer, and a failure is logged with its status
 * and nothing else, since the request's URL holds the bot token and its body the notice.
 *
 * The one thing kept is which notices were sent (their keys, such as `checks:owner/name:<sha>`), so that GitHub
 * delivering a webhook again, a second failed check on the same commit, or a release asking for the same review again
 * doesn't send the same notice twice. It is the least that does that job: keys only, no payloads or texts, at most
 * `MAX_SENT` of them and none older than `SENT_MS`, oldest dropped first, all in memory and lost on a restart. After
 * a restart a repeat can get through once, which is better than the relay keeping a store.
 */
export function telegramNotifier(options: {
  config: TelegramConfig;
  hub: Hub;
  /** The page's address, such as https://github.vorkinn.org, added to each notice when set. */
  dashboard?: string | undefined;
  fetch?: typeof fetch;
}): OnWebhook {
  const { config, hub, dashboard } = options;
  const fetcher = options.fetch ?? fetch;
  const sent = sentKeys(MAX_SENT, SENT_MS);

  return async (kind, payload, delivery) => {
    const notice = noticeFrom(kind, payload, delivery, dashboard);
    if (!notice || !nobodyWatching(hub) || sent.has(notice.key)) {
      return;
    }
    // Marked before sending, so a repeat arriving meanwhile isn't sent too; forgotten again if the send fails, so
    // GitHub delivering the webhook again can try once more.
    sent.add(notice.key);
    const failure = await send(fetcher, config, notice);
    if (failure) {
      sent.delete(notice.key);
      console.warn(`telegram notice not sent: ${failure}`);
    }
  };
}

function nobodyWatching(hub: Hub): boolean {
  const since = hub.idleSince();
  return since !== undefined && Date.now() - since >= QUIET_MS;
}

/** Sends one notice, and says why it failed, by status or kind of error only, or nothing if it went. */
async function send(fetcher: typeof fetch, config: TelegramConfig, notice: Notice): Promise<string | undefined> {
  const message: Record<string, unknown> = {
    chat_id: config.chatId,
    text: notice.text,
    link_preview_options: { is_disabled: true },
  };
  if (notice.review) {
    message.reply_markup = { inline_keyboard: [[{ text: "Review in GitHub", url: notice.review }]] };
  }
  try {
    const response = await fetcher(`${API}/bot${config.botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(message),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    // The answer isn't needed (and may quote the notice), so it is dropped unread, which frees the connection.
    await response.body?.cancel().catch(() => {});
    return response.ok ? undefined : `HTTP ${response.status}`;
  } catch (error) {
    // Only the kind of failure: a message could quote the URL, which holds the token.
    return error instanceof Error ? error.name : "request failed";
  }
}

/** A set of keys that holds at most `max` of them, each for at most `ttlMs`, dropping the oldest first. */
export function sentKeys(max: number, ttlMs: number) {
  // A Map keeps the order keys were added in, so the first entries are the oldest.
  const keys = new Map<string, number>();
  const prune = () => {
    const now = Date.now();
    for (const [key, at] of keys) {
      if (now - at < ttlMs && keys.size <= max) {
        break;
      }
      keys.delete(key);
    }
  };
  return {
    has(key: string): boolean {
      prune();
      return keys.has(key);
    },
    add(key: string): void {
      keys.delete(key);
      keys.set(key, Date.now());
      prune();
    },
    delete(key: string): void {
      keys.delete(key);
    },
    size: () => keys.size,
  };
}
