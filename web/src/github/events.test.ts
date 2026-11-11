// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { Notice } from "../model.ts";
import { BACKOFF_MS, type Change, createEvents, STEADY_MS } from "./events.ts";
import { fakeStreams } from "./testing.ts";

let isHidden = false;

beforeEach(() => {
  vi.useFakeTimers();
  isHidden = false;
  Object.defineProperty(document, "hidden", { configurable: true, get: () => isHidden });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function show(visible: boolean): void {
  isHidden = !visible;
  document.dispatchEvent(new Event("visibilitychange"));
}

function setUp() {
  const fake = fakeStreams();
  const lives: boolean[] = [];
  const changes: Change[] = [];
  const notices: Notice[] = [];
  const events = createEvents({
    connect: fake.connect,
    onLive: (live) => lives.push(live),
    onChange: (change) => changes.push(change),
    onNotice: (notice) => notices.push(notice),
  });
  return { ...fake, events, lives, changes, notices };
}

test("connects on start, and is live from the relay's hello", () => {
  const { events, streams, last, lives } = setUp();
  expect(streams).toHaveLength(0);
  events.start();
  events.start();
  expect(streams).toHaveLength(1);
  expect(events.live()).toBe(false);

  last().emit("hello");
  expect(events.live()).toBe(true);
  expect(lives).toEqual([true]);
  events.stop();
});

test("passes each change on, with the fields it has", () => {
  const { events, last, changes } = setUp();
  events.start();
  last().emit("hello");
  last().change({ kind: "check_run", repo: "octo/app", action: "completed", sha: "abc", pull: 4, run: 99 });
  last().change({ kind: "installation" });
  expect(changes).toEqual([
    { kind: "check_run", repo: "octo/app", action: "completed", sha: "abc", pull: 4, run: 99 },
    { kind: "installation" },
  ]);
  events.stop();
});

test.each([
  ["not JSON", "{oops"],
  ["nothing", ""],
  ["null", "null"],
  ["a list", "[1]"],
  ["a word", '"push"'],
  ["without a kind", '{"repo":"octo/app"}'],
  ["with a kind that isn't a word", '{"kind":7}'],
  ["with an empty kind", '{"kind":""}'],
])("data that is %s is no change, and nothing is thrown", (_, data) => {
  const { events, last, changes } = setUp();
  events.start();
  expect(() => last().emit("change", data)).not.toThrow();
  expect(changes).toEqual([]);
  events.stop();
});

test("a field of the wrong type is left out", () => {
  const { events, last, changes } = setUp();
  events.start();
  last().emit("change", '{"kind":"push","repo":["octo/app"],"action":1,"pull":"4","sha":null,"run":1.5,"more":true}');
  expect(changes).toEqual([{ kind: "push" }]);
  events.stop();
});

test("after an error it closes the stream and connects again, waiting longer each time and never giving up", () => {
  const { events, streams, last, lives } = setUp();
  events.start();
  last().emit("hello");

  const waits = [...BACKOFF_MS, 30_000, 30_000];
  expect(waits).toEqual([1000, 2000, 4000, 8000, 16_000, 30_000, 30_000, 30_000]);
  for (const [index, wait] of waits.entries()) {
    const failing = last();
    failing.emit("error");
    expect(failing.closed).toBe(true);
    expect(events.live()).toBe(false);
    vi.advanceTimersByTime(wait - 1);
    expect(streams).toHaveLength(index + 1);
    vi.advanceTimersByTime(1);
    expect(streams).toHaveLength(index + 2);
  }
  // Live once, and not again without a hello.
  expect(lives).toEqual([true, false]);
  events.stop();
});

test("a connection that lasted a minute starts the waits over; a shorter one doesn't", () => {
  const { events, streams, last } = setUp();
  events.start();
  last().emit("error");
  vi.advanceTimersByTime(1000);
  last().emit("error");
  vi.advanceTimersByTime(2000);
  expect(streams).toHaveLength(3);

  last().emit("hello");
  vi.advanceTimersByTime(STEADY_MS - 1);
  last().emit("error");
  vi.advanceTimersByTime(3999);
  expect(streams).toHaveLength(3);
  vi.advanceTimersByTime(1);
  expect(streams).toHaveLength(4);

  last().emit("hello");
  vi.advanceTimersByTime(STEADY_MS);
  last().emit("error");
  vi.advanceTimersByTime(1000);
  expect(streams).toHaveLength(5);
  events.stop();
});

test("a connection that can't even be made is tried again", () => {
  const fake = fakeStreams();
  let broken = true;
  const events = createEvents({
    connect() {
      if (broken) {
        throw new Error("no");
      }
      return fake.connect();
    },
    onLive: () => {},
    onChange: () => {},
  });
  expect(() => events.start()).not.toThrow();
  broken = false;
  vi.advanceTimersByTime(1000);
  expect(fake.streams).toHaveLength(1);
  events.stop();
});

test("a background page stays connected so desktop notifications can arrive", () => {
  const { events, streams, last, lives } = setUp();
  events.start();
  last().emit("hello");

  show(false);
  expect(last().closed).toBe(false);
  expect(lives).toEqual([true]);
  vi.advanceTimersByTime(10 * 60_000);
  expect(streams).toHaveLength(1);

  show(true);
  expect(streams).toHaveLength(1);
  expect(last().closed).toBe(false);
  expect(lives).toEqual([true]);
  events.stop();
});

test("a page connects and reconnects while it is in the background", () => {
  const { events, streams, last } = setUp();
  show(false);
  events.start();
  expect(streams).toHaveLength(1);

  last().emit("error");
  vi.advanceTimersByTime(BACKOFF_MS.at(0) ?? 0);
  expect(streams).toHaveLength(2);
  events.stop();
});

test("stop closes the stream, reconnects no more and listens to nothing", () => {
  const { events, streams, last, lives, changes } = setUp();
  events.start();
  last().emit("hello");
  events.stop();
  expect(last().closed).toBe(true);
  expect(events.live()).toBe(false);

  // What was already on its way from a closed stream is dropped.
  last().emit("hello");
  last().change({ kind: "push" });
  last().emit("error");
  show(false);
  show(true);
  vi.advanceTimersByTime(10 * 60_000);
  expect(streams).toHaveLength(1);
  expect(lives).toEqual([true, false]);
  expect(changes).toEqual([]);

  events.start();
  expect(streams).toHaveLength(2);
  events.stop();
});

test("stop while waiting to reconnect takes the wait back", () => {
  const { events, streams, last } = setUp();
  events.start();
  last().emit("error");
  events.stop();
  vi.advanceTimersByTime(60_000);
  expect(streams).toHaveLength(1);
  expect(vi.getTimerCount()).toBe(0);
});

test("without a way to connect it uses the browser's EventSource on the relay's stream", () => {
  const opened: string[] = [];
  class FakeEventSource {
    constructor(url: string) {
      opened.push(url);
    }
    addEventListener(): void {}
    close(): void {}
  }
  vi.stubGlobal("EventSource", FakeEventSource);
  const events = createEvents({ onLive: () => {}, onChange: () => {} });
  events.start();
  // Nothing but the path: the login in front of the relay goes by its cookie, and no token is put on an address.
  expect(opened).toEqual(["api/events"]);
  events.stop();
});

test("where there is no EventSource it never connects and is never live", () => {
  vi.stubGlobal("EventSource", undefined);
  const events = createEvents({ onLive: () => {}, onChange: () => {} });
  events.start();
  vi.advanceTimersByTime(60_000);
  expect(events.live()).toBe(false);
  expect(vi.getTimerCount()).toBe(0);
  events.stop();
});

const NOTICE: Notice = {
  type: "merged",
  key: "merged:octo/app#7",
  repo: "octo/app",
  headline: "Merged octo/app#7: Add parcels",
  url: "https://github.com/octo/app/pull/7",
};

test("passes each notice on", () => {
  const { events, last, notices, changes } = setUp();
  events.start();
  last().emit("hello");
  last().emit("notice", JSON.stringify({ ...NOTICE, extra: "left out" }));
  expect(notices).toEqual([NOTICE]);
  expect(changes).toEqual([]);
  events.stop();
});

test.each([
  ["not JSON", "{oops"],
  ["of an unknown kind", JSON.stringify({ ...NOTICE, type: "opened" })],
  ["without a key", JSON.stringify({ ...NOTICE, key: "" })],
  ["without a headline", JSON.stringify({ ...NOTICE, headline: 5 })],
  ["linking away from github.com", JSON.stringify({ ...NOTICE, url: "https://example.com/" })],
  ["with no repository", JSON.stringify({ ...NOTICE, repo: undefined })],
])("a notice %s is none, and nothing is thrown", (_, data) => {
  const { events, last, notices } = setUp();
  events.start();
  expect(() => last().emit("notice", data)).not.toThrow();
  expect(notices).toEqual([]);
  events.stop();
});
