import { NOTICE_TYPES, type Notice, type NoticeType } from "./model.ts";

/**
 * Desktop notifications: while the page is open, the things that need attention (see `Notice`) show as the
 * computer's own notifications, such as macOS's, through the browser's Notification API. They are the other half of
 * the relay's Telegram messages, which go only while no page is open.
 *
 * Which kinds show is the user's choice, kept in this browser like the hidden projects: a preference, nothing more.
 */

/** Which kinds of notice show as desktop notifications. */
export type NotificationSettings = Record<NoticeType, boolean>;

/** Where the browser keeps the settings, as a JSON object of kind to true or false. */
export const NOTIFICATIONS_KEY = "github-dashboard:notifications";

/** Every kind shows until the user turns it off, as every kind goes to Telegram. */
export const DEFAULT_SETTINGS: NotificationSettings = {
  merged: true,
  changes: true,
  checks: true,
  release: true,
  waiting: true,
};

/** Each kind as the settings page names it, and as a notification's title. */
export const NOTICE_LABELS: Record<NoticeType, { setting: string; title: string }> = {
  merged: { setting: "A pull request merged", title: "Pull request merged" },
  changes: { setting: "Changes requested on a pull request", title: "Changes requested" },
  checks: { setting: "Checks failed on a pull request", title: "Checks failed" },
  release: { setting: "A release run finished", title: "Release finished" },
  waiting: { setting: "A release run is waiting for your approval", title: "Waiting for your approval" },
};

/** The settings this browser keeps, or the defaults for whatever it doesn't. */
export function readSettings(): NotificationSettings {
  const settings = { ...DEFAULT_SETTINGS };
  try {
    const kept: unknown = JSON.parse(localStorage.getItem(NOTIFICATIONS_KEY) ?? "{}");
    if (typeof kept === "object" && kept !== null) {
      for (const type of NOTICE_TYPES) {
        const value = (kept as Record<string, unknown>)[type];
        if (typeof value === "boolean") {
          settings[type] = value;
        }
      }
    }
  } catch {
    // No storage (a private window, say), or something else's text under the key: the defaults.
  }
  return settings;
}

/** Keeps the settings in this browser. Where it won't keep them, they last as long as the page. */
export function writeSettings(settings: NotificationSettings): void {
  try {
    localStorage.setItem(NOTIFICATIONS_KEY, JSON.stringify(settings));
  } catch {
    // Not kept, then.
  }
}

/** Whether the browser can show notifications, and whether the user let it: the Notification API's word for it. */
export type Permission = NotificationPermission | "unsupported";

export function permission(): Permission {
  return typeof Notification === "undefined" ? "unsupported" : Notification.permission;
}

/** Asks the user to let the page show notifications. Must be called from a click, or browsers ignore it. */
export async function askPermission(): Promise<Permission> {
  if (typeof Notification === "undefined") {
    return "unsupported";
  }
  return await Notification.requestPermission();
}

/** As much of the browser's `Notification` as is used; tests pass their own. */
export type Show = (
  title: string,
  options: { body: string; tag: string },
) => { onclick: ((event: Event) => void) | null } | null;

/** Remembers this many notices as shown, so a repeat shows nothing. */
export const MAX_SEEN = 500;

/** Where this browser keeps the recent in-app notification history. */
export const NOTIFICATION_HISTORY_KEY = "github-dashboard:notification-history";
/** A bounded history is enough to recover recent context without growing browser storage forever. */
export const MAX_NOTIFICATION_HISTORY = 100;

/**
 * Recent notices kept by this browser, newest first. Only the public fields already present on `Notice` are read;
 * malformed entries and repeated keys are ignored.
 */
export function readNotificationHistory(): Notice[] {
  try {
    const kept: unknown = JSON.parse(localStorage.getItem(NOTIFICATION_HISTORY_KEY) ?? "[]");
    if (!Array.isArray(kept)) {
      return [];
    }
    const notices: Notice[] = [];
    const keys = new Set<string>();
    for (const value of kept) {
      const notice = storedNotice(value);
      if (!notice || keys.has(notice.key)) {
        continue;
      }
      notices.push(notice);
      keys.add(notice.key);
      if (notices.length === MAX_NOTIFICATION_HISTORY) {
        break;
      }
    }
    return notices;
  } catch {
    return [];
  }
}

/** Adds or refreshes one notice in the local history and returns the resulting newest-first list. */
export function addNotificationHistory(notice: Notice): Notice[] {
  const stored = storedNotice(notice);
  if (!stored) {
    return readNotificationHistory();
  }
  const history = [stored, ...readNotificationHistory().filter((existing) => existing.key !== stored.key)].slice(
    0,
    MAX_NOTIFICATION_HISTORY,
  );
  try {
    localStorage.setItem(NOTIFICATION_HISTORY_KEY, JSON.stringify(history));
  } catch {
    // It still serves this update to the caller when storage is unavailable.
  }
  return history;
}

/** Clears the in-app notification history kept by this browser. */
export function clearNotificationHistory(): void {
  try {
    localStorage.removeItem(NOTIFICATION_HISTORY_KEY);
  } catch {
    // Already effectively clear when storage is unavailable.
  }
}

function storedNotice(value: unknown): Notice | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const fields = value as Record<string, unknown>;
  if (
    typeof fields.type !== "string" ||
    !NOTICE_TYPES.includes(fields.type as NoticeType) ||
    typeof fields.key !== "string" ||
    fields.key.length === 0 ||
    typeof fields.repo !== "string" ||
    fields.repo.length === 0 ||
    typeof fields.headline !== "string" ||
    fields.headline.length === 0 ||
    typeof fields.url !== "string" ||
    fields.url.length === 0
  ) {
    return undefined;
  }
  return {
    type: fields.type as NoticeType,
    key: fields.key,
    repo: fields.repo,
    headline: fields.headline,
    url: fields.url,
  };
}

export type Notifier = {
  /** Shows `notice` as a desktop notification, unless it is a repeat, its kind is off, or its project is hidden. */
  notify(notice: Notice): void;
  /** Shows a sample notification, for the settings page's "Send a test", whatever the settings say. */
  test(): void;
};

export function createNotifier(options: {
  /** The project's the user has hidden: their notices show nothing, as their pull requests and runs show nothing. */
  hidden?: () => ReadonlySet<string>;
  settings?: () => NotificationSettings;
  /** Shows one notification. Left out, the browser's `Notification`, and only once the user allowed it. */
  show?: Show;
  /** Opens a link from a clicked notification. */
  open?: (url: string) => void;
}): Notifier {
  const settings = options.settings ?? readSettings;
  const show = options.show ?? browserShow;
  const open = options.open ?? ((url: string) => window.open(url, "_blank", "noopener"));
  // A Map keeps the order keys were added in, so the first are the oldest.
  const seen = new Map<string, true>();

  function display(title: string, body: string, tag: string, url: string | undefined): void {
    let shown: ReturnType<Show>;
    try {
      shown = show(title, { body, tag });
    } catch {
      // The browser refused (some want a service worker for it); the page shows the same thing anyway.
      return;
    }
    if (shown && url) {
      shown.onclick = () => open(url);
    }
  }

  return {
    notify(notice) {
      if (seen.has(notice.key)) {
        return;
      }
      seen.set(notice.key, true);
      if (seen.size > MAX_SEEN) {
        const oldest = seen.keys().next().value;
        if (oldest !== undefined) {
          seen.delete(oldest);
        }
      }
      if (!settings()[notice.type] || options.hidden?.().has(notice.repo)) {
        return;
      }
      display(NOTICE_LABELS[notice.type].title, notice.headline, notice.key, notice.url);
    },

    test() {
      display("GitHub dashboard", "Notifications from the dashboard show like this.", "test", undefined);
    },
  };
}

function browserShow(title: string, options: { body: string; tag: string }) {
  if (typeof Notification === "undefined" || Notification.permission !== "granted") {
    return null;
  }
  return new Notification(title, options);
}
