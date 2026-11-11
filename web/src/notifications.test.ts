// @vitest-environment happy-dom
import { afterEach, expect, test, vi } from "vitest";
import type { Notice } from "./model.ts";
import {
  createNotifier,
  DEFAULT_SETTINGS,
  MAX_SEEN,
  NOTIFICATIONS_KEY,
  readSettings,
  type Show,
  writeSettings,
} from "./notifications.ts";

afterEach(() => {
  localStorage.clear();
  vi.unstubAllGlobals();
});

const merged: Notice = {
  type: "merged",
  key: "merged:octo/app#7",
  repo: "octo/app",
  headline: "Merged octo/app#7: Add parcels",
  url: "https://github.com/octo/app/pull/7",
};

function setUp(options: { hidden?: string[]; settings?: Partial<typeof DEFAULT_SETTINGS> } = {}) {
  const shown: {
    title: string;
    body: string;
    tag: string;
    notification: { onclick: ((event: Event) => void) | null };
  }[] = [];
  const opened: string[] = [];
  const show: Show = (title, { body, tag }) => {
    const notification = { onclick: null };
    shown.push({ title, body, tag, notification });
    return notification;
  };
  const notifier = createNotifier({
    show,
    open: (url) => opened.push(url),
    hidden: () => new Set(options.hidden ?? []),
    settings: () => ({ ...DEFAULT_SETTINGS, ...options.settings }),
  });
  return { notifier, shown, opened };
}

test("a notice shows as a notification titled by its kind, and a click opens it on github.com", () => {
  const { notifier, shown, opened } = setUp();
  notifier.notify(merged);
  expect(shown.map(({ title, body, tag }) => ({ title, body, tag }))).toEqual([
    { title: "Pull request merged", body: "Merged octo/app#7: Add parcels", tag: "merged:octo/app#7" },
  ]);
  shown[0]?.notification.onclick?.(new Event("click"));
  expect(opened).toEqual(["https://github.com/octo/app/pull/7"]);
});

test("a repeat shows nothing", () => {
  const { notifier, shown } = setUp();
  notifier.notify(merged);
  notifier.notify({ ...merged });
  expect(shown).toHaveLength(1);
});

test("a kind that is turned off, or a hidden project, shows nothing", () => {
  const { notifier, shown } = setUp({ settings: { merged: false }, hidden: ["octo/hidden"] });
  notifier.notify(merged);
  notifier.notify({ ...merged, type: "checks", key: "checks:octo/hidden:1", repo: "octo/hidden" });
  notifier.notify({ ...merged, type: "checks", key: "checks:octo/app:1", headline: "Checks failed in octo/app" });
  expect(shown.map((one) => one.title)).toEqual(["Checks failed"]);
});

test("only so many notices are remembered, oldest forgotten first", () => {
  const { notifier, shown } = setUp();
  for (let index = 0; index <= MAX_SEEN; index++) {
    notifier.notify({ ...merged, key: `k${index}` });
  }
  notifier.notify({ ...merged, key: "k0" });
  notifier.notify({ ...merged, key: `k${MAX_SEEN}` });
  expect(shown).toHaveLength(MAX_SEEN + 2);
});

test("a browser that refuses to show one throws nothing", () => {
  const notifier = createNotifier({
    show: () => {
      throw new TypeError("Illegal constructor");
    },
  });
  expect(() => notifier.notify(merged)).not.toThrow();
});

test("the browser's notifications are used only once allowed", () => {
  const made: unknown[][] = [];
  class FakeNotification {
    static permission = "default";
    onclick = null;
    constructor(...args: unknown[]) {
      made.push(args);
    }
  }
  vi.stubGlobal("Notification", FakeNotification);
  const notifier = createNotifier({ settings: () => DEFAULT_SETTINGS });
  notifier.notify(merged);
  expect(made).toEqual([]);

  FakeNotification.permission = "granted";
  notifier.notify({ ...merged, key: "another" });
  expect(made).toEqual([["Pull request merged", { body: merged.headline, tag: "another" }]]);
});

test("settings default to every kind, and keep what was chosen in this browser", () => {
  expect(readSettings()).toEqual(DEFAULT_SETTINGS);
  writeSettings({ ...DEFAULT_SETTINGS, checks: false });
  expect(readSettings()).toEqual({ ...DEFAULT_SETTINGS, checks: false });

  localStorage.setItem(NOTIFICATIONS_KEY, '{"merged":"no","waiting":false,"other":true}');
  expect(readSettings()).toEqual({ ...DEFAULT_SETTINGS, waiting: false });
  localStorage.setItem(NOTIFICATIONS_KEY, "{oops");
  expect(readSettings()).toEqual(DEFAULT_SETTINGS);
});
