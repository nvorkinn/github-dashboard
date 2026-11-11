import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { createApp } from "./app.ts";
import { webhookSignature } from "./crypto.ts";
import type { Change } from "./events.ts";
import { createHub } from "./events.ts";

const SECRET = "webhook-secret";
const staticRoot = mkdtempSync(join(tmpdir(), "relay-static-"));

afterEach(() => {
  vi.useRealTimers();
});

/** Reads an event stream piece by piece. */
function reading(response: Response) {
  const reader = (response.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let text = "";
  return {
    /** Everything received so far, once it contains `wanted`. */
    async until(wanted: string): Promise<string> {
      while (!text.includes(wanted)) {
        const { done, value } = await reader.read();
        if (done) {
          throw new Error(`the stream ended before ${JSON.stringify(wanted)}; it sent ${JSON.stringify(text)}`);
        }
        text += decoder.decode(value, { stream: true });
      }
      return text;
    },
    /** Whether the stream has ended, reading whatever is left. */
    async ended(): Promise<boolean> {
      for (;;) {
        const { done } = await reader.read();
        if (done) {
          return true;
        }
      }
    },
    /** What a browser does when the page closes. */
    leave: () => reader.cancel(),
  };
}

test("the hub hands a change to everyone listening and remembers nothing", () => {
  const hub = createHub();
  hub.publish({ kind: "push" });

  const first: Change[] = [];
  const second: Change[] = [];
  const stopFirst = hub.subscribe((change) => first.push(change));
  hub.subscribe(() => {
    throw new Error("a listener that fails");
  });
  hub.subscribe((change) => second.push(change));
  expect(hub.listeners()).toBe(3);

  hub.publish({ kind: "release", action: "published" });
  // Nothing of the change published before anyone listened.
  expect(first).toEqual([{ kind: "release", action: "published" }]);
  expect(second).toEqual(first);

  stopFirst();
  stopFirst();
  expect(hub.listeners()).toBe(2);
  hub.publish({ kind: "status" });
  expect(first).toHaveLength(1);
  expect(second).toHaveLength(2);
});

test("the stream says hello on connecting, with headers that keep proxies from holding it back", async () => {
  const hub = createHub();
  const response = await createApp({ staticRoot, hub }).request("/api/events");
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("text/event-stream");
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("x-accel-buffering")).toBe("no");
  // The secure headers apply here as everywhere.
  expect(response.headers.get("content-security-policy")).toContain("default-src 'self'");

  const stream = reading(response);
  expect(await stream.until("\n\n")).toBe("event: hello\ndata: {}\n\n");
  expect(hub.listeners()).toBe(1);
  await stream.leave();
  expect(hub.listeners()).toBe(0);
});

test("a webhook reaches a connected reader as a change event", async () => {
  const hub = createHub();
  const app = createApp({ staticRoot, webhookSecret: SECRET, hub });
  const first = reading(await app.request("/api/events"));
  const second = reading(await app.request("/api/events"));
  await first.until("event: hello\ndata: {}\n\n");

  const body = JSON.stringify({
    action: "completed",
    repository: { full_name: "nvorkinn/github-dashboard" },
    workflow_run: { id: 99, head_sha: "a".repeat(40), pull_requests: [{ number: 5 }], name: "not passed on" },
  });
  const posted = await app.request("/api/github/webhook", {
    method: "POST",
    headers: { "X-GitHub-Event": "workflow_run", "X-Hub-Signature-256": webhookSignature(SECRET, Buffer.from(body)) },
    body,
  });
  expect(posted.status).toBe(204);

  const data = `{"kind":"workflow_run","repo":"nvorkinn/github-dashboard","action":"completed","pull":5,"sha":"${"a".repeat(40)}","run":99}`;
  const expected = `event: hello\ndata: {}\n\nevent: change\ndata: ${data}\n\n`;
  expect(await first.until("event: change")).toBe(expected);
  expect(await second.until("event: change")).toBe(expected);

  // A reader that connects afterwards hears nothing of it.
  const late = reading(await app.request("/api/events"));
  hub.publish({ kind: "push" });
  expect(await late.until("event: change")).toBe('event: hello\ndata: {}\n\nevent: change\ndata: {"kind":"push"}\n\n');

  await Promise.all([first.leave(), second.leave(), late.leave()]);
  expect(hub.listeners()).toBe(0);
});

test("a webhook that needs attention also reaches a connected reader as a notice, after its change", async () => {
  const hub = createHub();
  const app = createApp({ staticRoot, webhookSecret: SECRET, hub });
  const reader = reading(await app.request("/api/events"));
  await reader.until("event: hello\ndata: {}\n\n");

  const body = JSON.stringify({
    action: "closed",
    repository: { full_name: "nvorkinn/github-dashboard" },
    pull_request: { number: 7, merged: true, title: "Add notices", head: { sha: "b".repeat(40) } },
  });
  await app.request("/api/github/webhook", {
    method: "POST",
    headers: { "X-GitHub-Event": "pull_request", "X-Hub-Signature-256": webhookSignature(SECRET, Buffer.from(body)) },
    body,
  });

  const notice = {
    type: "merged",
    key: "merged:nvorkinn/github-dashboard#7",
    repo: "nvorkinn/github-dashboard",
    headline: "Merged nvorkinn/github-dashboard#7: Add notices",
    url: "https://github.com/nvorkinn/github-dashboard/pull/7",
  };
  const text = await reader.until("event: notice");
  expect(text.indexOf("event: change")).toBeGreaterThan(0);
  expect(text.indexOf("event: change")).toBeLessThan(text.indexOf("event: notice"));
  await reader.until(`event: notice\ndata: ${JSON.stringify(notice)}\n\n`);

  await reader.leave();
});

test("a notice goes only to listeners that asked for notices, and one that throws doesn't stop the rest", () => {
  const hub = createHub();
  const seen: string[] = [];
  hub.subscribe(() => {});
  hub.subscribe(
    () => {},
    () => {
      throw new Error("no");
    },
  );
  hub.subscribe(
    () => {},
    (notice) => seen.push(notice.key),
  );
  hub.announce({ type: "checks", key: "checks:a/b:1", repo: "a/b", headline: "Checks failed in a/b", url: "u" });
  expect(seen).toEqual(["checks:a/b:1"]);
});

test("a quiet stream sends a comment line at the interval, and stops when the reader leaves", async () => {
  vi.useFakeTimers();
  const hub = createHub();
  const stream = reading(await createApp({ staticRoot, hub, pingMs: 50 }).request("/api/events"));
  await stream.until("hello");
  expect(vi.getTimerCount()).toBe(1);

  await vi.advanceTimersByTimeAsync(49);
  hub.publish({ kind: "push" });
  expect(await stream.until("event: change")).not.toContain(": ping");
  await vi.advanceTimersByTimeAsync(101);
  expect(await stream.until(": ping\n\n: ping\n\n")).toMatch(/\n\n: ping\n\n: ping\n\n$/);

  await stream.leave();
  expect(vi.getTimerCount()).toBe(0);
  expect(hub.listeners()).toBe(0);
});

test("the default interval is 20 seconds", async () => {
  vi.useFakeTimers();
  const stream = reading(await createApp({ staticRoot }).request("/api/events"));
  await vi.advanceTimersByTimeAsync(19_999);
  expect(await stream.until("hello")).not.toContain("ping");
  await vi.advanceTimersByTimeAsync(1);
  await stream.until(": ping\n\n");
  await stream.leave();
  expect(vi.getTimerCount()).toBe(0);
});

test("a request that is aborted leaves no listener or timer", async () => {
  vi.useFakeTimers();
  const hub = createHub();
  const client = new AbortController();
  const request = new Request("http://relay/api/events", { signal: client.signal });
  const stream = reading(await createApp({ staticRoot, hub }).request(request));
  await stream.until("hello");
  expect(hub.listeners()).toBe(1);

  client.abort();
  expect(hub.listeners()).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
});

test("closing ends every open stream, and a later one at once", async () => {
  vi.useFakeTimers();
  const hub = createHub();
  const closing = new AbortController();
  const app = createApp({ staticRoot, hub, closing: closing.signal });
  const first = reading(await app.request("/api/events"));
  const second = reading(await app.request("/api/events"));
  await first.until("hello");
  expect(hub.listeners()).toBe(2);

  closing.abort();
  expect(await first.ended()).toBe(true);
  expect(await second.ended()).toBe(true);
  expect(await reading(await app.request("/api/events")).ended()).toBe(true);
  expect(hub.listeners()).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
});

test("a reader that stops reading is dropped instead of having its events pile up", async () => {
  vi.useFakeTimers();
  const hub = createHub();
  const stream = reading(await createApp({ staticRoot, hub }).request("/api/events"));
  await stream.until("hello");

  for (let i = 0; i < 1000 && hub.listeners() > 0; i += 1) {
    hub.publish({ kind: "push" });
  }
  expect(hub.listeners()).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
  expect(await stream.ended()).toBe(true);
});

test("the hub knows since when nobody has listened", () => {
  vi.useFakeTimers({ toFake: ["Date"], now: 1000 });
  const hub = createHub();
  // Made, and nobody has listened yet.
  expect(hub.idleSince()).toBe(1000);

  vi.setSystemTime(2000);
  const first = hub.subscribe(() => {});
  const second = hub.subscribe(() => {});
  expect(hub.idleSince()).toBeUndefined();

  vi.setSystemTime(3000);
  first();
  expect(hub.idleSince()).toBeUndefined();

  vi.setSystemTime(4000);
  second();
  expect(hub.idleSince()).toBe(4000);
  // Stopping again later changes nothing.
  vi.setSystemTime(5000);
  second();
  expect(hub.idleSince()).toBe(4000);
});
