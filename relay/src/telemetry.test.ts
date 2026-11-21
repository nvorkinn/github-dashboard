import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { createApp } from "./app.ts";
import { webhookSignature } from "./crypto.ts";
import { watchDeliveries } from "./deliveries.ts";
import { type Change, createHub } from "./events.ts";
import { createGitHubApp } from "./github_app.ts";
import { createTelemetry, telemetryEnabled, withPurpose } from "./telemetry.ts";
import { fakeApp, settle } from "./testing.ts";

const staticRoot = mkdtempSync(join(tmpdir(), "relay-static-"));
writeFileSync(join(staticRoot, "index.html"), "<!doctype html><title>page</title>");

afterEach(() => {
  vi.useRealTimers();
});

function recorder() {
  const lines: Record<string, unknown>[] = [];
  let clock = 0;
  const telemetry = createTelemetry({
    write: (line) => lines.push(JSON.parse(line)),
    now: () => (clock += 5),
  });
  return { lines, telemetry };
}

test("is on unless TELEMETRY says off", () => {
  expect(telemetryEnabled({})).toBe(true);
  expect(telemetryEnabled({ TELEMETRY: "on" })).toBe(true);
  expect(telemetryEnabled({ TELEMETRY: "off" })).toBe(false);
  expect(telemetryEnabled({ TELEMETRY: " False " })).toBe(false);
  expect(telemetryEnabled({ TELEMETRY: "0" })).toBe(false);
});

test("logs each request the relay answers, without its query or the health check", async () => {
  const { lines, telemetry } = recorder();
  const app = createApp({ staticRoot, telemetry });
  await app.request("/healthz");
  await app.request("/api/auth/callback?code=secret-code&state=x");
  await app.request("/");
  expect(lines).toEqual([
    expect.objectContaining({ telemetry: "http_in", method: "GET", path: "/api/auth/callback", status: 503, ms: 5 }),
    expect.objectContaining({ telemetry: "http_in", method: "GET", path: "/", status: 200 }),
  ]);
  expect(JSON.stringify(lines)).not.toContain("secret-code");
  expect(typeof lines[0]?.ts).toBe("string");
});

test("logs each request sent, with GitHub's rate limit and without query or bot token", async () => {
  const { lines, telemetry } = recorder();
  const fetcher = telemetry.outbound(
    async () =>
      new Response("{}", {
        status: 200,
        headers: {
          "content-length": "2",
          "x-ratelimit-resource": "graphql",
          "x-ratelimit-remaining": "4990",
          "x-ratelimit-used": "10",
        },
      }),
  );
  const response = await fetcher("https://api.github.com/graphql?x=1", { method: "post" });
  expect(await response.text()).toBe("{}");
  await fetcher(new Request("https://api.telegram.org/bot123:AAsecret/sendMessage"));
  expect(lines).toEqual([
    expect.objectContaining({
      telemetry: "http_out",
      method: "POST",
      host: "api.github.com",
      path: "/graphql",
      status: 200,
      ms: 5,
      bytes: 2,
      rateResource: "graphql",
      rateRemaining: 4990,
      rateUsed: 10,
    }),
    expect.objectContaining({
      telemetry: "http_out",
      method: "GET",
      host: "api.telegram.org",
      path: "/bot*/sendMessage",
    }),
  ]);
  expect(JSON.stringify(lines)).not.toContain("AAsecret");
});

test("logs a request that failed to send, and still throws", async () => {
  const { lines, telemetry } = recorder();
  const fetcher = telemetry.outbound(async () => {
    throw new TypeError("network down");
  });
  await expect(fetcher("https://api.github.com/user")).rejects.toThrow("network down");
  expect(lines).toEqual([expect.objectContaining({ telemetry: "http_out", path: "/user", error: "TypeError" })]);
  expect(lines[0]).not.toHaveProperty("status");
});

test("the relay's own calls go through the logging fetch", async () => {
  const { lines, telemetry } = recorder();
  const app = createApp({
    staticRoot,
    telemetry,
    fetch: async () => Response.json({ status: { indicator: "none", description: "ok" }, components: [] }),
  });
  await app.request("/api/github/status");
  expect(lines.map((line) => [line.telemetry, line.host ?? line.path])).toEqual([
    ["http_out", "www.githubstatus.com"],
    ["http_in", "/api/github/status"],
  ]);
});

test("a request sent under a purpose is logged with it, also after awaiting", async () => {
  const { lines, telemetry } = recorder();
  const fetcher = telemetry.outbound(async () => new Response("{}"));
  await withPurpose("runs.recheck", async () => {
    await Promise.resolve();
    await fetcher("https://api.github.com/repos/o/n/actions/runs/1");
    await withPurpose("runs.workflow_job", () => fetcher("https://api.github.com/repos/o/n/actions/runs/1/jobs"));
  });
  await fetcher("https://api.github.com/user");
  expect(lines.map((line) => line.purpose)).toEqual(["runs.recheck", "runs.workflow_job", undefined]);
});

test("a relay query's cost is logged with its purpose and taken out of the answer", async () => {
  const { lines, telemetry } = recorder();
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const fetcher = (async (url: string | URL | Request) =>
    /access_tokens$/.test(String(url))
      ? Response.json({ token: "ghs_x", expires_at: new Date(Date.now() + 3_600_000).toISOString() })
      : Response.json({ data: { rateLimit: { cost: 1, remaining: 4999 }, repository: { id: "R" } } })) as typeof fetch;
  const app = createGitHubApp({
    config: { appId: "1", privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString() },
    fetch: fetcher,
    telemetry,
  });
  const answer = await withPurpose("merge_states.push", () => app.query(7, "query { rateLimit { cost remaining } }"));
  expect(answer.data).toEqual({ repository: { id: "R" } });
  expect(lines).toEqual([
    expect.objectContaining({ telemetry: "graphql_cost", purpose: "merge_states.push", cost: 1, remaining: 4999 }),
  ]);
});

test("a signed webhook is logged with its delivery id, which also goes to the pages", async () => {
  const { lines, telemetry } = recorder();
  const hub = createHub();
  const published: Change[] = [];
  hub.subscribe((change) => published.push(change));
  const app = createApp({ staticRoot, webhookSecret: "s", hub, telemetry });
  const body = JSON.stringify({
    action: "opened",
    repository: { full_name: "o/n" },
    pull_request: { number: 7, title: "stays out" },
  });
  await app.request("/api/github/webhook", {
    method: "POST",
    headers: {
      "X-GitHub-Event": "pull_request",
      "X-GitHub-Delivery": "d-1",
      "X-Hub-Signature-256": webhookSignature("s", Buffer.from(body)),
    },
    body,
  });
  expect(published).toEqual([{ kind: "pull_request", repo: "o/n", action: "opened", pull: 7, delivery: "d-1" }]);
  expect(lines.find((line) => line.telemetry === "webhook")).toEqual(
    expect.objectContaining({
      kind: "pull_request",
      action: "opened",
      delivery: "d-1",
      bytes: body.length,
      repo: "o/n",
      pull: 7,
      pages: 1,
    }),
  );
  expect(JSON.stringify(lines)).not.toContain("stays out");
});

test("an event stream is logged when it opens and closes, with what it carried", async () => {
  const { lines, telemetry } = recorder();
  const hub = createHub();
  const response = await createApp({ staticRoot, hub, telemetry }).request("/api/events");
  const reader = (response.body as ReadableStream<Uint8Array>).getReader();
  await reader.read();
  hub.publish({ kind: "push" });
  await reader.read();
  await reader.cancel();
  const events = lines.filter((line) => String(line.telemetry).startsWith("stream_"));
  expect(events).toEqual([
    expect.objectContaining({ telemetry: "stream_opened", pages: 1 }),
    expect.objectContaining({
      telemetry: "stream_closed",
      pages: 0,
      sent: {
        hello: { count: 1, bytes: 23 },
        releases: expect.objectContaining({ count: 1 }),
        change: { count: 1, bytes: 37 },
      },
    }),
  ]);
});

test("GitHub's webhook deliveries are logged once each, read an hour apart", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  const { lines, telemetry } = recorder();
  const delivery = (id: number) => ({
    // An id too large for a JavaScript number comes as text (see `deliveryPage`).
    id: id === 2 ? "1152921504606846976" : id,
    guid: `g-${id}`,
    event: "push",
    action: null,
    delivered_at: "2026-11-16T07:00:00Z",
    duration: 0.25,
    status_code: 204,
    redelivery: id === 3,
  });
  const { app, routes, calls } = fakeApp([], { deliveries: [[delivery(3), delivery(2)], [delivery(1)]] });
  watchDeliveries({ app, telemetry });
  await vi.advanceTimersByTimeAsync(60_000);
  await settle();
  const deliveries = () => lines.filter((line) => line.telemetry === "webhook_delivery");
  expect(deliveries().map((line) => line.delivery)).toEqual(["g-3", "g-2", "g-1"]);
  expect(lines.at(-1)).toEqual(
    expect.objectContaining({ telemetry: "webhook_deliveries_read", pages: 2, items: 3, logged: 3, skipped: 0 }),
  );
  expect(lines[0]).toEqual(
    expect.objectContaining({ telemetry: "webhook_delivery", kind: "push", ms: 250, status: 204, redelivery: true }),
  );
  expect(lines[1]).not.toHaveProperty("redelivery");

  // The next read stops at the first one it already logged.
  routes.deliveries = [[delivery(4), delivery(3)], [delivery(2)]];
  calls.length = 0;
  await vi.advanceTimersByTimeAsync(60 * 60_000);
  await settle();
  expect(deliveries().map((line) => line.delivery)).toEqual(["g-3", "g-2", "g-1", "g-4"]);
  expect(lines.at(-1)).toEqual(expect.objectContaining({ pages: 1, logged: 1, reachedLogged: true }));
  expect(calls).toEqual(["deliveries"]);
});

test("a page's events are logged one line each, with only plain fields", async () => {
  const { lines, telemetry } = recorder();
  const app = createApp({ staticRoot, telemetry });
  const response = await app.request("/api/telemetry", {
    method: "POST",
    body: JSON.stringify({
      tab: "abc123",
      events: [
        { kind: "request", ts: "2026-11-16T07:00:00Z", path: "/user", status: 200, unchanged: true, nested: { a: 1 } },
        { kind: "read", reason: "x".repeat(500), "bad key": 1, telemetry: "forged" },
        { kind: "anything_else", path: "/user" },
        "not an event",
      ],
    }),
  });
  expect(response.status).toBe(204);
  expect(lines).toEqual([
    expect.objectContaining({
      telemetry: "page_request",
      tab: "abc123",
      at: "2026-11-16T07:00:00Z",
      path: "/user",
      status: 200,
      unchanged: true,
    }),
    expect.objectContaining({ telemetry: "page_read", tab: "abc123", reason: "x".repeat(200) }),
  ]);
  expect(lines[0]).not.toHaveProperty("nested");
  expect(lines[1]).not.toHaveProperty("bad key");
});

test("a page's events are refused when malformed, and answered 404 with telemetry off", async () => {
  const { telemetry } = recorder();
  const app = createApp({ staticRoot, telemetry });
  expect((await app.request("/api/telemetry", { method: "POST", body: "not json" })).status).toBe(400);
  expect((await app.request("/api/telemetry", { method: "POST", body: '{"tab":"A B","events":[]}' })).status).toBe(400);
  const off = createApp({ staticRoot });
  expect((await off.request("/api/telemetry", { method: "POST", body: '{"tab":"a","events":[]}' })).status).toBe(404);
});
