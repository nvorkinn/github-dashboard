/**
 * Reads the telemetry lines the relay logged (see "Telemetry" in the README) and prints, as Markdown, the tables
 * that decide how the dashboard should read GitHub: what it spends of the rate limit and on what, how many reads
 * find nothing new, how late changes show, what tabs duplicate, how each kind of request performs, and how bursts of
 * webhooks would be read with another wait.
 *
 *   node scripts/analyse.ts export.ndjson [more.ndjson ...]   (or the lines on stdin)
 *
 * A line is the relay's JSON as it printed it, a log store's record of it with that JSON as `_msg`, or one with its
 * fields parsed out as text (VictoriaLogs' export, either way: when the relay's JSON had no `_msg` of its own,
 * VictoriaLogs fills it with a note that isn't JSON, and the record's own fields are the line); anything else is
 * skipped.
 */
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

type Line = Record<string, unknown> & { telemetry: string; ts: string };

export function parseLines(text: string): Line[] {
  const lines: Line[] = [];
  for (const raw of text.split("\n")) {
    const one = tryJson(raw.trim());
    const line = (typeof one?._msg === "string" ? tryJson(one._msg) : undefined) ?? one;
    if (line && typeof line.telemetry === "string" && typeof line.ts === "string") {
      lines.push(typed(line) as Line);
    }
  }
  return lines.sort((a, b) => a.ts.localeCompare(b.ts));
}

/**
 * The line with numbers and yes or no as they were printed: a log store that parsed the JSON into fields of its own
 * (VictoriaLogs does) gives every value back as text.
 */
function typed(line: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(line)) {
    out[key] =
      key === "ts" || key === "delivery" || typeof value !== "string"
        ? value
        : /^-?\d+(\.\d+)?$/.test(value)
          ? Number(value)
          : value === "true" || value === "false"
            ? value === "true"
            : value;
  }
  return out;
}

function tryJson(text: string): Record<string, unknown> | undefined {
  if (!text.startsWith("{")) return undefined;
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

const num = (value: unknown): number | undefined => (typeof value === "number" ? value : undefined);
const str = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);
const time = (line: Line): number => Date.parse(line.ts);

function percentile(values: number[], p: number): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

function table(head: string[], rows: (string | number | undefined)[][]): string {
  if (rows.length === 0) return "_Nothing logged._\n";
  const cell = (value: string | number | undefined) => (value === undefined ? "" : String(value));
  return [
    `| ${head.join(" | ")} |`,
    `| ${head.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.map(cell).join(" | ")} |`),
  ].join("\n");
}

function group<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const name = key(item);
    groups.set(name, [...(groups.get(name) ?? []), item]);
  }
  return groups;
}

/** A path with its ids and names taken out, so that requests of one kind group together. */
export function shape(path: string): string {
  return path
    .replace(/^\/repos\/[^/]+\/[^/]+/, "/repos/:repo")
    .replace(/\/\d+(?=\/|$)/g, "/:n")
    .replace(/\/[0-9a-f]{40}(?=\/|$)/g, "/:sha")
    .replace(/\/(tags|ref\/tags|compare)\/.+$/, "/$1/:ref");
}

/** One call to api.github.com, from the relay or the page, in the same terms. */
type Call = { from: "relay" | "page"; at: number; method: string; path: string; purpose: string; line: Line };

function calls(lines: Line[]): Call[] {
  const found: Call[] = [];
  for (const line of lines) {
    const relay = line.telemetry === "http_out" && line.host === "api.github.com";
    if (!relay && line.telemetry !== "page_request") continue;
    found.push({
      from: relay ? "relay" : "page",
      at: time(line),
      method: str(line.method) ?? "GET",
      path: shape(str(line.path) ?? ""),
      purpose: str(line.purpose) ?? "(none)",
      line,
    });
  }
  return found;
}

/** How many reads `times` (sorted, ms) make with a wait of `wait` after the last, but no more than `max` after the first. */
export function bursts(times: number[], wait: number, max: number): number {
  let count = 0;
  let first = Number.NEGATIVE_INFINITY;
  let last = Number.NEGATIVE_INFINITY;
  for (const at of times) {
    if (at - last > wait || at - first > max) {
      count++;
      first = at;
    }
    last = at;
  }
  return count;
}

export function analyse(lines: Line[]): string {
  const out: string[] = [];
  const first = lines[0]?.ts;
  const last = lines.at(-1)?.ts;
  const hours = first && last ? Math.max((Date.parse(last) - Date.parse(first)) / 3_600_000, 1 / 60) : 0;
  out.push(`# Telemetry, ${first ?? "?"} to ${last ?? "?"} (${hours.toFixed(1)} h, ${lines.length} lines)\n`);

  // 1. What is spent, on what.
  const all = calls(lines);
  // GraphQL points: the page puts a query's cost on its request, the relay logs it as a line of its own.
  const relayPoints = new Map<string, number>();
  for (const line of lines.filter((one) => one.telemetry === "graphql_cost")) {
    const purpose = str(line.purpose) ?? "(none)";
    relayPoints.set(purpose, (relayPoints.get(purpose) ?? 0) + (num(line.cost) ?? 0));
  }
  out.push("## Calls to GitHub by purpose\n");
  out.push(
    table(
      ["From", "Purpose", "Calls", "Per hour", "GraphQL", "Points", "p50 ms", "p95 ms", "Avg KB"],
      [...group(all, (call) => `${call.from}\t${call.purpose}`)]
        .map(([key, items]) => {
          const [from, purpose] = key.split("\t");
          const ms = items.map((call) => num(call.line.ms)).filter((v): v is number => v !== undefined);
          const kb = items.map((call) => num(call.line.bytes)).filter((v): v is number => v !== undefined);
          const costs = items.map((call) => num(call.line.cost)).filter((v): v is number => v !== undefined);
          const points =
            from === "relay"
              ? relayPoints.get(purpose ?? "")
              : costs.length
                ? costs.reduce((a, b) => a + b, 0)
                : undefined;
          return [
            from,
            purpose,
            items.length,
            (items.length / hours).toFixed(1),
            items.filter((call) => call.path === "/graphql").length,
            points,
            percentile(ms, 50),
            percentile(ms, 95),
            kb.length ? (kb.reduce((a, b) => a + b, 0) / kb.length / 1024).toFixed(1) : undefined,
          ];
        })
        .sort((a, b) => Number(b[2]) - Number(a[2])),
    ),
  );
  out.push("\n## Rate limit\n");
  const rated = all.filter((call) => num(call.line.rateRemaining) !== undefined);
  out.push(
    table(
      ["From", "Resource", "Lowest remaining", "Used per hour (from the counter)"],
      [...group(rated, (call) => `${call.from}\t${str(call.line.rateResource) ?? "?"}`)].map(([key, items]) => {
        const [from, resource] = key.split("\t");
        const remaining = items.map((call) => num(call.line.rateRemaining) ?? 0);
        // The counter goes back to 0 each hour: the sum of its rises is what was used.
        let used = 0;
        let previous: number | undefined;
        for (const call of items) {
          const now = num(call.line.rateUsed);
          if (now !== undefined && previous !== undefined && now > previous) used += now - previous;
          if (now !== undefined) previous = now;
        }
        return [from, resource, Math.min(...remaining), (used / hours).toFixed(0)];
      }),
    ),
  );
  const costs = lines.filter((line) => line.telemetry === "graphql_cost");
  if (costs.length) {
    out.push(
      `\nRelay GraphQL: ${costs.length} queries, ${costs.reduce((sum, line) => sum + (num(line.cost) ?? 0), 0)} points.`,
    );
  }

  // 2. Reads that found nothing.
  out.push("\n## Page reads by reason\n");
  const reads = lines.filter((line) => line.telemetry === "page_read");
  const found = (line: Line) =>
    (num(line.projectsChanged) ?? 0) +
    (num(line.pullsAdded) ?? 0) +
    (num(line.pullsRemoved) ?? 0) +
    (num(line.pullsChanged) ?? 0);
  out.push(
    table(
      ["Reason", "Reads", "Per hour", "Found nothing", "Failed", "p50 ms", "p95 ms"],
      [...group(reads, (line) => `${str(line.reason)} ${line.all ? "(everything)" : "(changes)"}`)].map(
        ([reason, items]) => {
          const ok = items.filter((line) => line.failed === undefined);
          const ms = items.map((line) => num(line.ms) ?? 0);
          return [
            reason,
            items.length,
            (items.length / hours).toFixed(1),
            `${ok.filter((line) => found(line) === 0).length} of ${ok.length}`,
            items.length - ok.length,
            percentile(ms, 50),
            percentile(ms, 95),
          ];
        },
      ),
    ),
  );
  const missedByEvents = reads.filter(
    (line) => line.all && ["fallback", "visible"].includes(str(line.reason) ?? "") && found(line) > 0,
  );
  out.push(
    `\nReads of everything on a timer or on coming back that found something: ${missedByEvents.length}. ` +
      "Each is a change no event brought (or one that came while the tab was hidden).",
  );

  // 3. How late changes show.
  out.push("\n## Freshness\n");
  const shown = lines.filter((line) => line.telemetry === "page_change_shown");
  const webhooks = new Map(
    lines.filter((line) => line.telemetry === "webhook").map((line) => [str(line.delivery), line] as const),
  );
  // The relay logs the deliveries it reads again after a restart, so each counts once.
  const deliveries = [
    ...new Map(
      lines.filter((line) => line.telemetry === "webhook_delivery").map((line) => [str(line.delivery), line] as const),
    ).values(),
  ];
  // A delivery from before the first webhook line may have come before the export began.
  const firstWebhook = Math.min(...[...webhooks.values()].map(time));
  const lag = deliveries
    .map((line) => {
      const arrived = webhooks.get(str(line.delivery));
      const sent = Date.parse(str(line.deliveredAt) ?? "");
      return arrived && Number.isFinite(sent) ? time(arrived) - sent : undefined;
    })
    .filter((v): v is number => v !== undefined);
  const lost = deliveries.filter(
    (line) => !webhooks.has(str(line.delivery)) && !(Date.parse(str(line.deliveredAt) ?? "") < firstWebhook),
  );
  const failedDeliveries = deliveries.filter((line) => (num(line.status) ?? 0) >= 300 || line.status === undefined);
  out.push(
    table(
      ["Step", "Count", "p50 ms", "p95 ms", "Max ms"],
      [
        ["GitHub sent → relay got (clock skew included)", lag.length, ...stats(lag)],
        ["Relay answered GitHub", deliveries.length, ...stats(deliveries.map((line) => num(line.ms) ?? 0))],
        ["Change came → its read began", shown.length, ...stats(shown.map((line) => num(line.waitedMs) ?? 0))],
        ["Change came → shown", shown.length, ...stats(shown.map((line) => num(line.totalMs) ?? 0))],
      ],
    ),
  );
  out.push(
    `\nGitHub's log has ${deliveries.length} deliveries: ${lost.length} with no webhook line in the relay's log ` +
      `(${failedDeliveries.length} failed on GitHub's side), ` +
      `${deliveries.filter((line) => line.redelivery).length} redeliveries.`,
  );

  // 4. Tabs and duplication.
  out.push("\n## Tabs\n");
  const pageLines = lines.filter((line) => line.telemetry.startsWith("page_"));
  const tabs = new Set(pageLines.map((line) => str(line.tab)));
  const byHour = group(pageLines, (line) => line.ts.slice(0, 13));
  const together = [...byHour.values()].map((items) => new Set(items.map((line) => str(line.tab))).size);
  const pageCalls = all.filter((call) => call.from === "page" && call.method === "GET");
  let repeated = 0;
  const seen = new Map<string, { at: number; tab: string | undefined }>();
  for (const call of pageCalls) {
    const key = `${call.line.path}`;
    const before = seen.get(key);
    if (before && call.at - before.at < 60_000 && before.tab !== str(call.line.tab)) repeated++;
    seen.set(key, { at: call.at, tab: str(call.line.tab) });
  }
  out.push(
    `${tabs.size} tabs in all; at most ${Math.max(0, ...together)} in one hour. ` +
      `${repeated} of ${pageCalls.length} page GETs repeated another tab's within a minute. ` +
      `${pageCalls.filter((call) => call.line.unchanged === true).length} came back unchanged by ETag.`,
  );

  // 5. Request shapes.
  out.push("\n## Requests by shape\n");
  out.push(
    table(
      ["From", "Request", "Calls", "p50 ms", "p95 ms", "Avg KB", "Unchanged"],
      [...group(all, (call) => `${call.from}\t${call.method} ${call.path}`)]
        .map(([key, items]) => {
          const [from, request] = key.split("\t");
          const ms = items.map((call) => num(call.line.ms) ?? 0);
          const kb = items.map((call) => num(call.line.bytes)).filter((v): v is number => v !== undefined);
          const unchanged = items.filter((call) => call.line.unchanged === true).length;
          return [
            from,
            request,
            items.length,
            percentile(ms, 50),
            percentile(ms, 95),
            kb.length ? (kb.reduce((a, b) => a + b, 0) / kb.length / 1024).toFixed(1) : undefined,
            from === "page" ? unchanged : undefined,
          ];
        })
        .sort((a, b) => Number(b[2]) - Number(a[2]))
        .slice(0, 30),
    ),
  );

  // 6. Bursts.
  out.push("\n## Webhook bursts per repository, read with other waits\n");
  const byRepo = group(
    lines.filter((line) => line.telemetry === "webhook" && str(line.repo)),
    (line) => str(line.repo) ?? "",
  );
  const times = [...byRepo.values()].map((items) => items.map(time));
  out.push(
    table(
      ["Wait after last (max 5 s)", "Reads"],
      [500, 1000, 2000, 5000].map((wait) => [
        `${wait} ms`,
        times.reduce((sum, repo) => sum + bursts(repo, wait, 5000), 0),
      ]),
    ),
  );
  out.push(
    `\n${[...byRepo.values()].reduce((sum, items) => sum + items.length, 0)} webhooks named a repository; ` +
      `the page's wait today is 1000 ms.`,
  );

  // 7. Streams.
  const closed = lines.filter((line) => line.telemetry === "stream_closed");
  out.push(
    `\n## Event streams\n\n${lines.filter((line) => line.telemetry === "stream_opened").length} opened, ` +
      `${closed.length} closed (median ${percentile(
        closed.map((line) => num(line.seconds) ?? 0),
        50,
      )} s open), ${closed.filter((line) => line.overflowed).length} dropped for not reading.`,
  );
  return `${out.join("\n")}\n`;
}

function stats(values: number[]): (number | undefined)[] {
  return [percentile(values, 50), percentile(values, 95), values.length ? Math.max(...values) : undefined];
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const files = process.argv.slice(2);
  const text = files.length ? files.map((file) => readFileSync(file, "utf8")).join("\n") : readFileSync(0, "utf8");
  process.stdout.write(analyse(parseLines(text)));
}
