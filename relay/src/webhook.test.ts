import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createApp } from "./app.ts";
import { webhookSignature } from "./crypto.ts";
import type { Change } from "./events.ts";
import { createHub } from "./events.ts";
import { changeFrom, webhookRoutes } from "./webhook.ts";

const SECRET = "webhook-secret";
const SHA = "0123456789abcdef0123456789abcdef01234567";
const staticRoot = mkdtempSync(join(tmpdir(), "relay-static-"));

/** An app with the webhook set up, and the changes it has published. */
function setUp(secret: string | undefined = SECRET) {
  const hub = createHub();
  const published: Change[] = [];
  hub.subscribe((change) => published.push(change));
  return { app: createApp({ staticRoot, webhookSecret: secret, hub }), published };
}

/** A webhook as GitHub sends it, signed with `secret`. `headers` replace or (with undefined) remove the usual ones. */
function delivery(event: string, body: string, headers: Record<string, string | undefined> = {}, secret = SECRET) {
  const all: Record<string, string | undefined> = {
    "Content-Type": "application/json",
    "X-GitHub-Event": event,
    "X-Hub-Signature-256": webhookSignature(secret, Buffer.from(body)),
    ...headers,
  };
  const set = Object.entries(all).filter((entry): entry is [string, string] => entry[1] !== undefined);
  return { method: "POST", headers: Object.fromEntries(set), body };
}

const pullRequestBody = JSON.stringify({
  action: "opened",
  repository: { full_name: "nvorkinn/github-dashboard", private: true },
  pull_request: { number: 7, title: "a title that stays here", head: { sha: SHA } },
  sender: { login: "someone" },
});

let warnings: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  warnings = vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  // No log line may carry the secret, a signature or anything from a body.
  for (const line of warnings.mock.calls.flat().map(String)) {
    expect(line).not.toMatch(/webhook-secret|sha256=|a title|someone|nvorkinn/);
  }
  vi.restoreAllMocks();
});

test("a signed webhook is published as a minimal change", async () => {
  const { app, published } = setUp();
  const response = await app.request("/api/github/webhook", delivery("pull_request", pullRequestBody));
  expect(response.status).toBe(204);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(published).toEqual([
    { kind: "pull_request", repo: "nvorkinn/github-dashboard", action: "opened", pull: 7, sha: SHA },
  ]);
  expect(warnings).not.toHaveBeenCalled();
});

test("without a secret the endpoint answers 503", async () => {
  const { app, published } = setUp("");
  const response = await app.request("/api/github/webhook", delivery("pull_request", pullRequestBody));
  expect(response.status).toBe(503);
  expect(published).toEqual([]);
});

test("a missing, wrong or malformed signature is refused", async () => {
  const { app, published } = setUp();
  const good = webhookSignature(SECRET, Buffer.from(pullRequestBody));
  const signatures = [
    undefined,
    "",
    "sha256=",
    "sha256",
    good.slice(0, -1),
    `${good}0`,
    good.replace("sha256=", "sha1="),
    good.replace("sha256=", ""),
    `sha256=${"z".repeat(64)}`,
    "sha256=æøå",
    webhookSignature("another-secret", Buffer.from(pullRequestBody)),
    webhookSignature(SECRET, Buffer.from(`${pullRequestBody} `)),
  ];
  for (const signature of signatures) {
    const request = delivery("pull_request", pullRequestBody, { "X-Hub-Signature-256": signature });
    const response = await app.request("/api/github/webhook", request);
    expect(response.status, String(signature)).toBe(401);
  }
  expect(published).toEqual([]);
  expect(warnings).toHaveBeenCalledTimes(signatures.length);
  expect(warnings.mock.calls[0]?.[0]).toBe("webhook refused: missing or wrong signature (event pull_request)");
});

test("an event name that doesn't look like one stays out of the log", async () => {
  const { app } = setUp();
  const request = delivery("someone forged this", "{}", { "X-Hub-Signature-256": "sha256=00" });
  expect((await app.request("/api/github/webhook", request)).status).toBe(401);
  expect(warnings.mock.calls[0]?.[0]).toBe("webhook refused: missing or wrong signature (event unknown)");
});

test("the signature is checked before the body is read as JSON", async () => {
  const { app } = setUp();
  const request = delivery("pull_request", "not json", { "X-Hub-Signature-256": "sha256=00" });
  expect((await app.request("/api/github/webhook", request)).status).toBe(401);
});

test("a ping is answered and not published", async () => {
  const { app, published } = setUp();
  const body = JSON.stringify({ zen: "Keep it logically awesome.", hook_id: 1 });
  const response = await app.request("/api/github/webhook", delivery("ping", body));
  expect(response.status).toBe(204);
  expect(published).toEqual([]);
});

test("a signed body that isn't a JSON object is refused", async () => {
  const { app, published } = setUp();
  for (const body of ["", "not json", "payload=%7B%7D", "[1]", '"text"', "null"]) {
    const response = await app.request("/api/github/webhook", delivery("push", body));
    expect(response.status, body).toBe(400);
  }
  expect(published).toEqual([]);
});

test("a signed webhook with no usable event name is refused", async () => {
  const { app, published } = setUp();
  for (const event of [undefined, "", "Pull Request", "x".repeat(65)]) {
    const request = delivery("push", "{}", { "X-GitHub-Event": event });
    expect((await app.request("/api/github/webhook", request)).status, String(event)).toBe(400);
  }
  expect(published).toEqual([]);
});

test("a body over the limit is refused, whether or not it says how long it is", async () => {
  const hub = createHub();
  const published: Change[] = [];
  hub.subscribe((change) => published.push(change));
  const routes = webhookRoutes({ secret: SECRET, hub, maxBodyBytes: 64 });

  const fits = JSON.stringify({ action: "x".repeat(40) });
  expect((await routes.request("/webhook", delivery("push", fits))).status).toBe(204);

  const large = JSON.stringify({ action: "x".repeat(100) });
  const declared = delivery("push", large, { "Content-Length": String(Buffer.byteLength(large)) });
  expect((await routes.request("/webhook", declared)).status).toBe(413);

  // Sent in pieces with no length: reading stops once the limit is passed, and the rest is never asked for.
  let pieces = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      pieces += 1;
      controller.enqueue(new Uint8Array(40));
    },
  });
  const streamed = new Request("http://relay/webhook", {
    method: "POST",
    headers: { "X-GitHub-Event": "push", "X-Hub-Signature-256": "sha256=00" },
    body: stream,
    duplex: "half",
  } as RequestInit);
  expect((await routes.request(streamed)).status).toBe(413);
  expect(pieces).toBeLessThan(5);

  expect(published).toEqual([{ kind: "push", action: "x".repeat(40) }]);
});

test("the hook sees each signed webhook whole, with its delivery id, after the change is published", async () => {
  const hub = createHub();
  const order: string[] = [];
  hub.subscribe(() => order.push("published"));
  const seen: unknown[][] = [];
  const routes = webhookRoutes({
    secret: SECRET,
    hub,
    onWebhook: (...args) => {
      order.push("hook");
      seen.push(args);
    },
  });

  const id = "72d3162e-cc78-11e3-81ab-4c9367dc0958";
  const signed = delivery("pull_request", pullRequestBody, { "X-GitHub-Delivery": id });
  expect((await routes.request("/webhook", signed)).status).toBe(204);
  await new Promise((resolve) => setImmediate(resolve));
  expect(seen).toEqual([["pull_request", JSON.parse(pullRequestBody), id]]);
  expect(order).toEqual(["published", "hook"]);

  // A delivery id that doesn't look like one is left out; a ping and a refused webhook reach no hook.
  await routes.request("/webhook", delivery("push", "{}", { "X-GitHub-Delivery": "not one" }));
  await routes.request("/webhook", delivery("ping", "{}"));
  await routes.request("/webhook", delivery("push", "{}", { "X-Hub-Signature-256": "sha256=00" }));
  await new Promise((resolve) => setImmediate(resolve));
  expect(seen.slice(1)).toEqual([["push", {}, undefined]]);
});

test("a hook that throws or rejects leaves the answer alone, and is logged by the kind of error", async () => {
  for (const onWebhook of [
    () => {
      throw new TypeError("nvorkinn: a message that could quote the payload");
    },
    () => Promise.reject(new RangeError("nvorkinn")),
  ]) {
    const routes = webhookRoutes({ secret: SECRET, hub: createHub(), onWebhook });
    expect((await routes.request("/webhook", delivery("pull_request", pullRequestBody))).status).toBe(204);
  }
  await new Promise((resolve) => setImmediate(resolve));
  expect(warnings.mock.calls).toEqual([["webhook hook failed: TypeError"], ["webhook hook failed: RangeError"]]);
});

test("GitHub's own limit of 25 MB is the default", async () => {
  const { app, published } = setUp();
  const request = delivery("push", "{}", { "Content-Length": String(25 * 1024 * 1024 + 1) });
  expect((await app.request("/api/github/webhook", request)).status).toBe(413);
  expect(published).toEqual([]);
});

const repository = { full_name: "nvorkinn/home-stack" };

test.each<[string, string, unknown, Change]>([
  ["a bare event has only its kind", "repository", {}, { kind: "repository" }],
  [
    "repo and action",
    "release",
    { action: "published", repository, release: { tag_name: "v1.0.0" } },
    { kind: "release", repo: "nvorkinn/home-stack", action: "published" },
  ],
  [
    "pull request: number and head",
    "pull_request",
    { action: "synchronize", repository, pull_request: { number: 12, head: { sha: SHA, ref: "branch" } } },
    { kind: "pull_request", repo: "nvorkinn/home-stack", action: "synchronize", pull: 12, sha: SHA },
  ],
  [
    "pull request review: the pull request it is on",
    "pull_request_review",
    { action: "submitted", review: { id: 5, body: "looks good" }, pull_request: { number: 3, head: { sha: SHA } } },
    { kind: "pull_request_review", action: "submitted", pull: 3, sha: SHA },
  ],
  [
    "check run: head and the first pull request",
    "check_run",
    { action: "completed", check_run: { id: 9, head_sha: SHA, pull_requests: [{ number: 4 }, { number: 5 }] } },
    { kind: "check_run", action: "completed", pull: 4, sha: SHA },
  ],
  [
    "check suite: head, and the first entry that has a number",
    "check_suite",
    { check_suite: { head_sha: SHA, pull_requests: [{}, { number: "6" }, { number: 8 }] } },
    { kind: "check_suite", pull: 8, sha: SHA },
  ],
  [
    "check suite on a branch with no pull request",
    "check_suite",
    { check_suite: { head_sha: SHA, pull_requests: [] } },
    { kind: "check_suite", sha: SHA },
  ],
  [
    "workflow run: head, pull request and run",
    "workflow_run",
    {
      action: "requested",
      workflow_run: { id: 4242, head_sha: SHA, pull_requests: [{ number: 2 }], path: ".github/workflows/release.yml" },
    },
    { kind: "workflow_run", action: "requested", pull: 2, sha: SHA, run: 4242, path: ".github/workflows/release.yml" },
  ],
  [
    "workflow job: head and the run it belongs to",
    "workflow_job",
    { action: "queued", workflow_job: { id: 1, run_id: 4242, head_sha: SHA } },
    { kind: "workflow_job", action: "queued", sha: SHA, run: 4242 },
  ],
  [
    "deployment review: the run that waits",
    "deployment_review",
    { action: "requested", workflow_run: { id: 77, head_sha: SHA, pull_requests: [] } },
    { kind: "deployment_review", action: "requested", sha: SHA, run: 77 },
  ],
  [
    "status: its sha",
    "status",
    { sha: SHA, state: "success", repository },
    { kind: "status", repo: repository.full_name, sha: SHA },
  ],
  [
    "push: the commit after",
    "push",
    { before: "0".repeat(40), after: SHA, ref: "refs/heads/main" },
    { kind: "push", sha: SHA },
  ],
  ["sha and after mean nothing on other events", "release", { sha: SHA, after: SHA }, { kind: "release" }],
  [
    "a comment on a pull request",
    "issue_comment",
    { action: "created", issue: { number: 31, pull_request: { url: "https://api.github.com/..." } } },
    { kind: "issue_comment", action: "created", pull: 31 },
  ],
  [
    "a comment on an issue names no pull request",
    "issue_comment",
    { action: "created", issue: { number: 31 } },
    { kind: "issue_comment", action: "created" },
  ],
  [
    "values of the wrong type are left out",
    "workflow_run",
    {
      action: 1,
      repository: { full_name: ["nvorkinn/home-stack"] },
      pull_request: { number: "12", head: { sha: 12 } },
      workflow_run: { id: "4242", head_sha: "not a sha", pull_requests: "none", path: 7 },
      workflow_job: { run_id: 1.5, head_sha: null },
    },
    { kind: "workflow_run" },
  ],
  [
    "text too long to be a name is left out",
    "release",
    { action: "x".repeat(201), repository: { full_name: "y".repeat(201) } },
    { kind: "release" },
  ],
  ["a payload that is no object", "push", null, { kind: "push" }],
])("extracts %s", (_name, kind, payload, expected) => {
  const change = changeFrom(kind, payload);
  expect(change).toEqual(expected);
  // Absent fields are left out, not sent as null or undefined.
  expect(Object.keys(change).sort()).toEqual(Object.keys(expected).sort());
});
