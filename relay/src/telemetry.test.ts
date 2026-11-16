import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { createApp } from "./app.ts";
import { createTelemetry, telemetryEnabled } from "./telemetry.ts";

const staticRoot = mkdtempSync(join(tmpdir(), "relay-static-"));
writeFileSync(join(staticRoot, "index.html"), "<!doctype html><title>page</title>");

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
