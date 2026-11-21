import { afterEach, expect, test, vi } from "vitest";
import { REDELIVER_WITHIN_MS, watchDeliveries } from "./deliveries.ts";
import { deliveryPage } from "./github_app.ts";
import { createTelemetry } from "./telemetry.ts";
import { fakeApp, settle } from "./testing.ts";

afterEach(() => {
  vi.useRealTimers();
});

const NOW = Date.parse("2026-11-21T20:00:00Z");

function delivery(id: string, guid: string, status: number, options: { at?: number; redelivery?: boolean } = {}) {
  return {
    id,
    guid,
    event: "push",
    action: null,
    delivered_at: new Date(options.at ?? NOW - 60_000).toISOString(),
    duration: 0.1,
    status_code: status,
    redelivery: options.redelivery ?? false,
  };
}

async function watched(pages: unknown[][], routes: Record<string, unknown> = {}) {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  const lines: Record<string, unknown>[] = [];
  const telemetry = createTelemetry({ write: (line) => lines.push(JSON.parse(line)) });
  const github = fakeApp([], { deliveries: pages, ...routes });
  watchDeliveries({ app: github.app, telemetry, now: () => NOW });
  await vi.advanceTimersByTimeAsync(60_000);
  await settle();
  return { ...github, lines };
}

test("a delivery that failed is asked for again once, oldest first, and one a later attempt made up for isn't", async () => {
  const { calls, routes, lines } = await watched([
    [
      delivery("6", "ok", 204),
      // Made up for by the redelivery above it.
      delivery("5", "fixed", 204, { redelivery: true }),
      delivery("4", "fixed", 502),
      delivery("3", "lost-a", 500),
    ],
    [
      delivery("2", "lost-b", 502),
      // Failed twice: only its newest attempt is asked for.
      delivery("1", "lost-b", 502, { at: NOW - 120_000 }),
    ],
  ]);
  expect(calls.filter((call) => call.startsWith("redeliver"))).toEqual(["redeliver 2", "redeliver 3"]);
  expect(lines.filter((line) => line.telemetry === "webhook_redelivery").map((line) => line.delivery)).toEqual([
    "lost-b",
    "lost-a",
  ]);
  expect(lines.at(-1)).toEqual(expect.objectContaining({ telemetry: "webhook_deliveries_read", redelivered: 2 }));

  // The next hour the redeliveries failed too: they aren't asked for again.
  routes.deliveries = [
    [delivery("8", "lost-a", 502, { redelivery: true }), delivery("7", "lost-b", 502), delivery("6", "ok", 204)],
  ];
  calls.length = 0;
  await vi.advanceTimersByTimeAsync(60 * 60_000);
  await settle();
  expect(calls).toEqual(["deliveries"]);
});

test("a failed delivery older than the window isn't asked for, and one GitHub refuses is logged", async () => {
  const { calls, lines } = await watched(
    [[delivery("2", "new", 500), delivery("1", "old", 500, { at: NOW - REDELIVER_WITHIN_MS - 1 })]],
    { redeliver: 422 },
  );
  expect(calls.filter((call) => call.startsWith("redeliver"))).toEqual(["redeliver 2"]);
  expect(lines.find((line) => line.telemetry === "webhook_redelivery")).toEqual(
    expect.objectContaining({ delivery: "new", error: "HTTP 422" }),
  );
});

test("failed deliveries are asked for again also with telemetry off", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  const github = fakeApp([], { deliveries: [[delivery("1", "lost", 502)]] });
  watchDeliveries({ app: github.app, now: () => NOW });
  await vi.advanceTimersByTimeAsync(60_000);
  await settle();
  expect(github.calls).toEqual(["deliveries", "redeliver 1"]);
});

test("a page of the delivery log keeps each id exactly, as text", () => {
  expect(
    deliveryPage('[{"id": 123456789012345678901, "guid": "g", "installation_id": 5, "repository_id": 6}]'),
  ).toEqual([{ id: "123456789012345678901", guid: "g", installation_id: 5, repository_id: 6 }]);
  expect(deliveryPage("not json")).toBeUndefined();
});
