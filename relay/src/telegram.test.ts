import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createApp } from "./app.ts";
import type { AuthConfig, TelegramConfig } from "./config.ts";
import { webhookSignature } from "./crypto.ts";
import { createHub } from "./events.ts";
import { MAX_SENT, QUIET_MS, SENT_MS, sentKeys } from "./telegram.ts";

const SECRET = "webhook-secret";
const TOKEN = "123456:bot-token-SECRET";
const telegram: TelegramConfig = { botToken: TOKEN, chatId: "42" };
const SHA = "0123456789abcdef0123456789abcdef01234567";
const OTHER_SHA = "fedcba9876543210fedcba9876543210fedcba98";
const staticRoot = mkdtempSync(join(tmpdir(), "relay-static-"));

const repository = { full_name: "nvorkinn/github-dashboard" };
function failedCheck(sha = SHA, kind = "check_run") {
  return {
    action: "completed",
    repository,
    [kind]: { conclusion: "failure", head_sha: sha, pull_requests: [{ number: 7 }] },
  };
}
const FAILED_TEXT = "Checks failed in nvorkinn/github-dashboard\nhttps://github.com/nvorkinn/github-dashboard/pull/7";

/** A fake fetch that answers `status`, or throws when `status` is an error, and the calls it got. */
function fakeFetch(answer: number | Error = 200) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    if (answer instanceof Error) {
      throw answer;
    }
    return new Response(JSON.stringify({ ok: answer === 200, description: "may quote the message" }), {
      status: answer,
    });
  }) as typeof fetch;
  return { fetcher, calls, bodies: () => calls.map((call) => JSON.parse(String(call.init.body))) };
}

function setUp(options: { answer?: number | Error; auth?: AuthConfig; telegram?: TelegramConfig | undefined } = {}) {
  const hub = createHub();
  const fake = fakeFetch(options.answer);
  const app = createApp({
    staticRoot,
    webhookSecret: SECRET,
    telegram: "telegram" in options ? options.telegram : telegram,
    auth: options.auth,
    hub,
    fetch: fake.fetcher,
  });
  /** Posts a signed webhook and waits until whatever it set off has finished. */
  const post = async (kind: string, payload: unknown, delivery = "d-1") => {
    const body = JSON.stringify(payload);
    const response = await app.request("/api/github/webhook", {
      method: "POST",
      headers: {
        "X-GitHub-Event": kind,
        "X-GitHub-Delivery": delivery,
        "X-Hub-Signature-256": webhookSignature(SECRET, Buffer.from(body)),
      },
      body,
    });
    await settle();
    return response.status;
  };
  /** Opens the event stream as a page does; the function returned closes it. */
  const openPage = async () => {
    const response = await app.request("/api/events");
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    await reader.read();
    return () => reader.cancel();
  };
  return { ...fake, hub, post, openPage };
}

/** Lets the work a webhook set off after its answer run to the end. */
const settle = () => new Promise((resolve) => setImmediate(resolve));
const later = (ms: number) => vi.setSystemTime(Date.now() + ms);

let logs: ReturnType<typeof vi.spyOn>[];
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  logs = (["log", "info", "warn", "error"] as const).map((level) =>
    vi.spyOn(console, level).mockImplementation(() => {}),
  );
});
afterEach(() => {
  // No log line may carry the token, the URL with it, or a notice's text.
  for (const line of logs.flatMap((spy) => spy.mock.calls.flat().map(String))) {
    expect(line).not.toMatch(/bot-token|123456|api\.telegram\.org|Checks failed|nvorkinn|may quote/);
  }
  vi.restoreAllMocks();
  vi.useRealTimers();
});

test("a failed check is sent to the chat when no page has been open for 30 seconds", async () => {
  const { post, calls, bodies } = setUp();
  later(QUIET_MS);
  expect(await post("check_run", failedCheck())).toBe(204);

  expect(calls).toHaveLength(1);
  const [call] = calls;
  expect(call?.url).toBe(`https://api.telegram.org/bot${TOKEN}/sendMessage`);
  expect(call?.init.method).toBe("POST");
  expect(new Headers(call?.init.headers).get("content-type")).toBe("application/json");
  expect(call?.init.signal).toBeInstanceOf(AbortSignal);
  expect(bodies()).toEqual([{ chat_id: "42", text: FAILED_TEXT, link_preview_options: { is_disabled: true } }]);
});

test("the notice links the dashboard when the relay knows its address", async () => {
  const auth: AuthConfig = {
    clientId: "Iv1.client",
    clientSecret: "secret",
    cookieKey: randomBytes(32),
    publicOrigin: "https://github.vorkinn.org",
    secureCookies: true,
  };
  const { post, bodies } = setUp({ auth });
  later(QUIET_MS);
  await post("check_run", failedCheck());
  expect(bodies()[0]?.text).toBe(`${FAILED_TEXT}\nDashboard: https://github.vorkinn.org`);
});

test("a release waiting for approval gets a button that opens its run", async () => {
  const { post, bodies } = setUp();
  later(QUIET_MS);
  const job = { workflow_name: "Release", run_id: 99, run_attempt: 1 };
  await post("workflow_job", { action: "waiting", repository, workflow_job: job });
  const run = "https://github.com/nvorkinn/github-dashboard/actions/runs/99";
  expect(bodies()[0]?.reply_markup).toEqual({ inline_keyboard: [[{ text: "Review in GitHub", url: run }]] });
});

test("nothing is sent for a webhook that needs no attention, or without Telegram set up", async () => {
  const quiet = setUp();
  later(QUIET_MS);
  await quiet.post("check_run", { ...failedCheck(), check_run: { conclusion: "success", head_sha: SHA } });
  await quiet.post("pull_request", { action: "opened", repository, pull_request: { number: 7 } });
  expect(quiet.calls).toEqual([]);

  const bare = setUp({ telegram: undefined });
  later(QUIET_MS);
  expect(await bare.post("check_run", failedCheck())).toBe(204);
  expect(bare.calls).toEqual([]);
});

test("quiet while a page is open, and for 30 seconds after the last one leaves", async () => {
  const { post, openPage, calls } = setUp();
  later(QUIET_MS);
  const first = await openPage();
  const second = await openPage();
  later(QUIET_MS * 10);
  await post("check_run", failedCheck(SHA));
  expect(calls).toHaveLength(0);

  // One page left; the other still watches.
  await first();
  later(QUIET_MS);
  await post("check_run", failedCheck(SHA));
  expect(calls).toHaveLength(0);

  await second();
  later(QUIET_MS - 1);
  await post("check_run", failedCheck(SHA));
  expect(calls).toHaveLength(0);

  // A reload: the page comes back within the 30 seconds, and the wait starts again when it leaves.
  const reloaded = await openPage();
  await reloaded();
  later(QUIET_MS - 1);
  await post("check_run", failedCheck(SHA));
  expect(calls).toHaveLength(0);

  later(1);
  await post("check_run", failedCheck(SHA));
  expect(calls).toHaveLength(1);
});

test("quiet for the first 30 seconds after the relay starts, while open pages connect again", async () => {
  const { post, calls } = setUp();
  later(QUIET_MS - 1);
  await post("check_run", failedCheck());
  expect(calls).toHaveLength(0);
  later(1);
  await post("check_run", failedCheck());
  expect(calls).toHaveLength(1);
});

test("the same notice is sent once: a redelivery, a suite after its run, another failed check on the commit", async () => {
  const { post, calls } = setUp();
  later(QUIET_MS);
  await post("check_run", failedCheck(SHA), "d-1");
  await post("check_run", failedCheck(SHA), "d-1");
  await post("check_run", failedCheck(SHA), "d-2");
  await post("check_suite", failedCheck(SHA, "check_suite"), "d-3");
  expect(calls).toHaveLength(1);

  // A new commit fails anew.
  await post("check_run", failedCheck(OTHER_SHA), "d-4");
  expect(calls).toHaveLength(2);

  // Two jobs of one release run waiting are one notice; the run's next attempt is another.
  const waiting = (job: number, attempt: number) => ({
    action: "waiting",
    repository,
    workflow_job: { id: job, workflow_name: "Release", run_id: 99, run_attempt: attempt },
  });
  await post("workflow_job", waiting(1, 1));
  await post("workflow_job", waiting(2, 1));
  await post("workflow_job", waiting(3, 2));
  expect(calls).toHaveLength(4);
});

test("a failed send doesn't touch the webhook's answer, is logged by status, and may be tried again", async () => {
  const { post, calls, bodies } = setUp({ answer: 401 });
  later(QUIET_MS);
  expect(await post("check_run", failedCheck())).toBe(204);
  expect(await post("check_run", failedCheck())).toBe(204);
  expect(calls).toHaveLength(2);
  expect(bodies()[1]?.text).toBe(FAILED_TEXT);
  expect(logs[2]?.mock.calls).toEqual([["telegram notice not sent: HTTP 401"], ["telegram notice not sent: HTTP 401"]]);
});

test("a send that throws or times out is logged by the kind of error only", async () => {
  const error = new TypeError(`fetch failed: https://api.telegram.org/bot${TOKEN}/sendMessage`);
  const { post, calls } = setUp({ answer: error });
  later(QUIET_MS);
  expect(await post("check_run", failedCheck())).toBe(204);
  expect(calls).toHaveLength(1);
  expect(logs[2]?.mock.calls).toEqual([["telegram notice not sent: TypeError"]]);
});

test("a send that never answers doesn't hold up the webhook's answer", async () => {
  const hub = createHub();
  let started = 0;
  const hanging = (() => {
    started += 1;
    return new Promise(() => {});
  }) as typeof fetch;
  const app = createApp({ staticRoot, webhookSecret: SECRET, telegram, hub, fetch: hanging });
  later(QUIET_MS);
  const body = JSON.stringify(failedCheck());
  const response = await app.request("/api/github/webhook", {
    method: "POST",
    headers: { "X-GitHub-Event": "check_run", "X-Hub-Signature-256": webhookSignature(SECRET, Buffer.from(body)) },
    body,
  });
  expect(response.status).toBe(204);
  await settle();
  expect(started).toBe(1);
});

test("the sent keys are bounded by count and by age, oldest first", () => {
  const sent = sentKeys(3, 1000);
  for (const key of ["a", "b", "c", "d"]) {
    sent.add(key);
  }
  expect(sent.size()).toBe(3);
  expect(sent.has("a")).toBe(false);
  expect(sent.has("b")).toBe(true);

  later(500);
  sent.add("e");
  expect(sent.has("b")).toBe(false);
  expect(sent.has("c")).toBe(true);
  later(500);
  // c and d are a second old now; e is half that.
  expect(sent.has("c")).toBe(false);
  expect(sent.has("d")).toBe(false);
  expect(sent.has("e")).toBe(true);
  expect(sent.size()).toBe(1);
  sent.delete("e");
  expect(sent.has("e")).toBe(false);

  expect(MAX_SENT).toBe(500);
  expect(SENT_MS).toBe(24 * 60 * 60 * 1000);
});
