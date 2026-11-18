import { expect, test } from "vitest";
import { analyse, bursts, parseLines, shape } from "./analyse.ts";

const at = (seconds: number) => new Date(Date.UTC(2026, 10, 16, 8, 0, seconds)).toISOString();
const line = (seconds: number, fields: Record<string, unknown>) => JSON.stringify({ ts: at(seconds), ...fields });

const sample = [
  line(0, {
    telemetry: "http_out",
    host: "api.github.com",
    method: "GET",
    path: "/repos/o/n/actions/runs/12",
    purpose: "runs.recheck",
    status: 200,
    ms: 120,
    bytes: 2048,
    rateResource: "core",
    rateRemaining: 4990,
    rateUsed: 10,
  }),
  // As VictoriaLogs exports it.
  JSON.stringify({
    _time: at(1),
    _msg: line(1, { telemetry: "webhook", kind: "pull_request", delivery: "d-1", repo: "o/n", pull: 1 }),
  }),
  line(2, { telemetry: "webhook_delivery", delivery: "d-1", deliveredAt: at(0), ms: 30, status: 204 }),
  line(3, { telemetry: "webhook_delivery", delivery: "d-2", deliveredAt: at(2), ms: 0, status: 502 }),
  // Read again after the relay restarted: counted once.
  line(3, { telemetry: "webhook_delivery", delivery: "d-2", deliveredAt: at(2), ms: 0, status: 502 }),
  // Sent before the first webhook line, so maybe before the export began: not counted as lost.
  line(3, { telemetry: "webhook_delivery", delivery: "d-0", deliveredAt: at(-60), ms: 20, status: 204 }),
  line(4, {
    telemetry: "page_read",
    tab: "t1",
    reason: "fallback",
    all: true,
    ms: 800,
    projectsChanged: 0,
    pullsAdded: 0,
    pullsRemoved: 0,
    pullsChanged: 0,
  }),
  line(5, {
    telemetry: "page_read",
    tab: "t1",
    reason: "event",
    all: false,
    ms: 200,
    projectsChanged: 0,
    pullsAdded: 0,
    pullsRemoved: 0,
    pullsChanged: 1,
  }),
  line(6, { telemetry: "page_change_shown", tab: "t1", delivery: "d-1", waitedMs: 1000, totalMs: 1300 }),
  line(7, { telemetry: "page_request", tab: "t1", method: "POST", path: "/graphql", purpose: "read.changes", cost: 2 }),
  line(7, { telemetry: "page_request", tab: "t1", method: "POST", path: "/graphql", purpose: "read.changes", cost: 3 }),
  line(7, {
    telemetry: "page_request",
    tab: "t1",
    method: "GET",
    path: "/repos/o/n/pulls/1/files",
    purpose: "review.files",
    status: 200,
    ms: 90,
    unchanged: true,
  }),
  line(8, {
    telemetry: "page_request",
    tab: "t2",
    method: "GET",
    path: "/repos/o/n/pulls/1/files",
    purpose: "review.files",
    status: 200,
    ms: 95,
  }),
  // As VictoriaLogs exports it with the JSON parsed into fields, every value as text, and a note of its own as `_msg`.
  JSON.stringify({
    _msg: "missing _msg field; see https://docs.victoriametrics.com/victorialogs/keyconcepts/#message-field",
    _time: at(9),
    ts: at(9),
    telemetry: "page_read",
    tab: "t2",
    reason: "visible",
    all: "true",
    ms: "300",
    pullsAdded: "0",
  }),
  "not json",
  JSON.stringify({ msg: "relay listening on :8080" }),
].join("\n");

test("reads the relay's lines, as printed or as a log store exports them", () => {
  const lines = parseLines(sample);
  expect(lines.map((one) => one.telemetry)).toEqual([
    "http_out",
    "webhook",
    "webhook_delivery",
    "webhook_delivery",
    "webhook_delivery",
    "webhook_delivery",
    "page_read",
    "page_read",
    "page_change_shown",
    "page_request",
    "page_request",
    "page_request",
    "page_request",
    "page_read",
  ]);
  expect(lines.at(-1)).toEqual(expect.objectContaining({ all: true, ms: 300, pullsAdded: 0 }));
});

test("groups request paths by shape", () => {
  expect(shape("/repos/o/n/actions/runs/12/jobs")).toBe("/repos/:repo/actions/runs/:n/jobs");
  expect(shape("/repos/o/n/commits/0123456789abcdef0123456789abcdef01234567/check-runs")).toBe(
    "/repos/:repo/commits/:sha/check-runs",
  );
  expect(shape("/graphql")).toBe("/graphql");
});

test("counts reads of a burst for a given wait, no later than the most after its first", () => {
  expect(bursts([0, 400, 800, 3000], 1000, 5000)).toBe(2);
  expect(bursts([0, 400, 800, 3000], 500, 5000)).toBe(2);
  expect(bursts([0, 900, 1800, 2700, 3600, 4500, 5400], 1000, 5000)).toBe(2);
});

test("prints the tables the plan asks for", () => {
  const report = analyse(parseLines(sample));
  expect(report).toContain("| relay | runs.recheck | 1 |");
  expect(report).toMatch(/\| page \| read\.changes \| 2 \| [\d.]+ \| 2 \| 5 \|/);
  expect(report).toContain("| fallback (everything) | 1 |");
  expect(report).toContain("1 of 1");
  expect(report).toContain(
    "GitHub's log has 3 deliveries: 1 with no webhook line in the relay's log (1 failed on GitHub's side)",
  );
  expect(report).toContain("| Change came → shown | 1 | 1300 | 1300 | 1300 |");
  expect(report).toContain("2 tabs in all");
  expect(report).toContain("1 of 2 page GETs repeated another tab's within a minute. 1 came back unchanged by ETag.");
});
