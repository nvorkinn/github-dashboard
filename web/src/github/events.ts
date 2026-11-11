/**
 * The relay's notices of what changed on GitHub, pushed to the page over Server-Sent Events. A notice only says
 * that something changed and where; what it is now is read from api.github.com as always. The stream is the relay's
 * own address, so the browser sends the cookies of the login in front of it and no token goes anywhere near it.
 */

/** One webhook GitHub sent the relay, cut down to what says where to look. */
export type Change = {
  /** GitHub's name for the event, such as `pull_request` or `check_run`. */
  kind: string;
  /** `owner/name`. */
  repo?: string;
  action?: string;
  /** A pull request's number. */
  pull?: number;
  /** The head commit the event is about. */
  sha?: string;
  /** A workflow run's id. */
  run?: number;
};

import { NOTICE_TYPES, type Notice, type NoticeType } from "../model.ts";

/** As much of an `EventSource` as is used. */
export type EventStream = {
  addEventListener(type: string, listener: (event: Event) => void): void;
  close(): void;
};

/** Opens the stream. A test passes one that makes a fake. */
export type Connect = () => EventStream;

export type EventsOptions = {
  /** Left out, the browser's `EventSource` on the relay's stream; where there is none, nothing ever connects. */
  connect?: Connect | undefined;
  /** `true` on every connect, when the relay says hello; `false` when that connection ends. */
  onLive(live: boolean): void;
  onChange(change: Change): void;
  /** Something that needs attention, for a desktop notification. */
  onNotice?(notice: Notice): void;
};

export type Events = {
  /** Connects, and from then on stays connected while the page is visible. */
  start(): void;
  stop(): void;
  /** Whether changes arrive as they happen: from the relay's hello until the connection ends. */
  live(): boolean;
};

// How long to wait before connecting again, after the first failure, the second and so on; the last one from then on.
export const BACKOFF_MS = [1000, 2000, 4000, 8000, 16_000, 30_000];
// A connection that lasted this long was a good one, so the next failure starts the waits over.
export const STEADY_MS = 60_000;

const STREAM_PATH = "api/events";

/**
 * The page's end of the stream. The relay keeps no history, so whatever happened while not connected is lost: each
 * `onLive(true)` means "read everything". Reconnecting is done here and not left to `EventSource`, which gives up
 * for good on some failures (an answer that isn't a stream, such as the login's page or a 502 from the proxy).
 */
export function createEvents(options: EventsOptions): Events {
  let started = false;
  let stream: EventStream | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let live = false;
  let liveSince = 0;
  let failures = 0;

  function setLive(next: boolean): void {
    if (live !== next) {
      live = next;
      liveSince = Date.now();
      options.onLive(next);
    }
  }

  function open(): void {
    const connect = options.connect ?? browserConnect();
    if (!connect || stream || !started || hidden()) {
      return;
    }
    let mine: EventStream;
    try {
      mine = connect();
    } catch {
      failed();
      return;
    }
    stream = mine;
    // A stream that was closed can still deliver what was already on its way, hence the checks that it is this one.
    mine.addEventListener("hello", () => {
      if (stream === mine) {
        setLive(true);
      }
    });
    mine.addEventListener("change", (event) => {
      const change = stream === mine ? parse(event) : undefined;
      if (change) {
        options.onChange(change);
      }
    });
    mine.addEventListener("notice", (event) => {
      const notice = stream === mine ? parseNotice(event) : undefined;
      if (notice) {
        options.onNotice?.(notice);
      }
    });
    mine.addEventListener("error", () => {
      if (stream === mine) {
        failed();
      }
    });
  }

  function close(): void {
    clearTimeout(retry);
    retry = undefined;
    stream?.close();
    stream = undefined;
    setLive(false);
  }

  function failed(): void {
    if (live && Date.now() - liveSince >= STEADY_MS) {
      failures = 0;
    }
    close();
    retry = setTimeout(open, BACKOFF_MS[Math.min(failures, BACKOFF_MS.length - 1)]);
    failures++;
  }

  function onVisibility(): void {
    // Nobody is looking at a hidden page, and a connection held open costs the relay and a phone's battery.
    close();
    failures = 0;
    open();
  }

  return {
    start() {
      if (started) {
        return;
      }
      started = true;
      failures = 0;
      if (typeof document !== "undefined") {
        document.addEventListener("visibilitychange", onVisibility);
      }
      open();
    },

    stop() {
      started = false;
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", onVisibility);
      }
      close();
    },

    live: () => live,
  };
}

function browserConnect(): Connect | undefined {
  return typeof EventSource === "undefined" ? undefined : () => new EventSource(STREAM_PATH);
}

function hidden(): boolean {
  return typeof document !== "undefined" && document.hidden;
}

function dataOf(event: Event): Record<string, unknown> | undefined {
  let data: unknown;
  try {
    data = JSON.parse(String((event as MessageEvent).data));
  } catch {
    return undefined;
  }
  return typeof data === "object" && data !== null ? (data as Record<string, unknown>) : undefined;
}

/**
 * The notice an event carries, or nothing if its data isn't one: every field must be there, of its type, and its link
 * must go to github.com, since a click opens it.
 */
function parseNotice(event: Event): Notice | undefined {
  const data = dataOf(event);
  if (!data) {
    return undefined;
  }
  const { type, key, repo, headline, url } = data;
  if (
    typeof type !== "string" ||
    !(NOTICE_TYPES as readonly string[]).includes(type) ||
    typeof key !== "string" ||
    key === "" ||
    typeof repo !== "string" ||
    typeof headline !== "string" ||
    headline === "" ||
    typeof url !== "string" ||
    !url.startsWith("https://github.com/")
  ) {
    return undefined;
  }
  return { type: type as NoticeType, key, repo, headline, url };
}

/** The change an event carries, or nothing if its data isn't one. Fields of the wrong type are left out. */
function parse(event: Event): Change | undefined {
  const data = dataOf(event);
  if (!data) {
    return undefined;
  }
  const { kind, repo, action, pull, sha, run } = data;
  if (typeof kind !== "string" || kind === "") {
    return undefined;
  }
  return {
    kind,
    ...(typeof repo === "string" ? { repo } : {}),
    ...(typeof action === "string" ? { action } : {}),
    ...(typeof pull === "number" && Number.isInteger(pull) ? { pull } : {}),
    ...(typeof sha === "string" ? { sha } : {}),
    ...(typeof run === "number" && Number.isInteger(run) ? { run } : {}),
  };
}
