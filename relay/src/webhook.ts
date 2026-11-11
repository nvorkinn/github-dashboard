import type { Context } from "hono";
import { Hono } from "hono";
import { validWebhookSignature } from "./crypto.ts";
import type { Change, Hub } from "./events.ts";
import { noticeFrom, pageNotice } from "./notices.ts";
import { commit, isRecord, pullNumbers, record, text, wholeNumber } from "./payload.ts";

/** What may look at a signed webhook's whole payload besides `changeFrom` (see `webhookRoutes`). */
export type OnWebhook = (
  kind: string,
  payload: Record<string, unknown>,
  delivery: string | undefined,
) => void | Promise<void>;

/** GitHub sends no webhook larger than this. */
export const MAX_WEBHOOK_BYTES = 25 * 1024 * 1024;

// Every event name GitHub has is lower-case words joined by underscores.
const EVENT_NAME = /^[a-z][a-z_]{0,63}$/;
// GitHub's delivery ids are GUIDs; anything else in the header is left out.
const DELIVERY = /^[0-9A-Za-z-]{1,64}$/;

/**
 * The webhook endpoint, mounted at /api/github: `POST /webhook` takes the GitHub App's webhooks and publishes a
 * minimal notice of each (see `changeFrom`) for the open pages, and for one that needs attention a notice the page
 * can show as a desktop notification (see notices.ts). Nothing of a webhook is kept once it is answered.
 *
 * Anyone can reach this path (GitHub can't sign in at the reverse proxy), so the signature made with the webhook
 * secret is the only thing that tells GitHub from anyone else, and it is checked against the bytes as they came,
 * before anything reads them as JSON. Without `secret` the endpoint answers 503.
 *
 * `onWebhook`, when given, sees each signed webhook whole: its event name, its payload and its delivery id
 * (`X-GitHub-Delivery`). It is for the Telegram notices (see telegram.ts), which need more of the payload than a
 * `Change` carries; the payload goes nowhere else. It runs after the answer is settled, so whatever it does or fails
 * at, GitHub still gets its 204.
 */
export function webhookRoutes(options: {
  secret: string | undefined;
  hub: Hub;
  maxBodyBytes?: number;
  onWebhook?: OnWebhook | undefined;
}) {
  const routes = new Hono();
  const { secret, hub } = options;
  const maxBodyBytes = options.maxBodyBytes ?? MAX_WEBHOOK_BYTES;

  routes.post("/webhook", async (c) => {
    c.header("Cache-Control", "no-store");
    if (!secret) {
      return c.text("Webhooks are not configured: set GITHUB_WEBHOOK_SECRET", 503);
    }

    // The reason goes to the log; the event name does only if it looks like one, since anyone can send the header.
    const header = c.req.header("X-GitHub-Event") ?? "";
    const kind = EVENT_NAME.test(header) ? header : undefined;
    const refuse = (status: 400 | 401 | 413, reason: string) => {
      console.warn(`webhook refused: ${reason} (event ${kind ?? "unknown"})`);
      return c.text(reason, status);
    };

    const body = await readBody(c, maxBodyBytes);
    if (!body) {
      return refuse(413, "body too large");
    }
    if (!validWebhookSignature(secret, body, c.req.header("X-Hub-Signature-256"))) {
      return refuse(401, "missing or wrong signature");
    }
    if (!kind) {
      return refuse(400, "no event name");
    }
    if (kind === "ping") {
      // GitHub's hello when the webhook is set up. Nothing changed, so the pages hear nothing.
      return c.body(null, 204);
    }

    let payload: unknown;
    try {
      payload = JSON.parse(body.toString("utf8"));
    } catch {
      return refuse(400, "body is not JSON");
    }
    if (!isRecord(payload)) {
      return refuse(400, "body is not a JSON object");
    }
    hub.publish(changeFrom(kind, payload));

    const id = c.req.header("X-GitHub-Delivery") ?? "";
    const delivery = DELIVERY.test(id) ? id : undefined;
    // What needs attention also goes to the open pages as a notice, for their desktop notifications. The pages tell
    // repeats apart themselves, so the relay remembers nothing for this.
    const notice = noticeFrom(kind, payload, delivery);
    if (notice) {
      hub.announce(pageNotice(notice));
    }

    const { onWebhook } = options;
    if (onWebhook) {
      const whole = payload;
      // In a later turn, so the answer never waits for it, and caught, so its failing never reaches the answer.
      void Promise.resolve()
        .then(() => onWebhook(kind, whole, delivery))
        .catch((error: unknown) => {
          console.warn(`webhook hook failed: ${error instanceof Error ? error.name : "unknown error"}`);
        });
    }
    return c.body(null, 204);
  });

  return routes;
}

/**
 * The request's body as it came, or nothing if it is longer than `limit`. It stops reading at the limit, so an
 * oversized body is never held in memory.
 */
async function readBody(c: Context, limit: number): Promise<Buffer | undefined> {
  const declared = Number(c.req.header("Content-Length") ?? "0");
  if (declared > limit) {
    return undefined;
  }
  const stream = c.req.raw.body;
  if (!stream) {
    return Buffer.alloc(0);
  }
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      return Buffer.concat(chunks, length);
    }
    length += value.byteLength;
    if (length > limit) {
      await reader.cancel().catch(() => {});
      return undefined;
    }
    chunks.push(value);
  }
}

/**
 * What the pages are told about one webhook: its event name and, where the payload has them in the expected type,
 * the repository, the action, the pull request, the head commit and the workflow run. Each value is copied out by
 * name; the payload itself, and anything else in it, goes no further.
 */
export function changeFrom(kind: string, payload: unknown): Change {
  const change: Change = { kind };
  const root = record(payload);

  const pullRequest = record(root.pull_request);
  const issue = record(root.issue);
  const checkRun = record(root.check_run);
  const checkSuite = record(root.check_suite);
  const workflowRun = record(root.workflow_run);
  const workflowJob = record(root.workflow_job);

  const repo = text(record(root.repository).full_name);
  if (repo !== undefined) {
    change.repo = repo;
  }

  const action = text(root.action);
  if (action !== undefined) {
    change.action = action;
  }

  const pull =
    wholeNumber(pullRequest.number) ??
    pullNumbers(checkRun.pull_requests)[0] ??
    pullNumbers(checkSuite.pull_requests)[0] ??
    pullNumbers(workflowRun.pull_requests)[0] ??
    // Comments on a pull request come as issue events; the issue then says it is a pull request.
    (isRecord(issue.pull_request) ? wholeNumber(issue.number) : undefined);
  if (pull !== undefined) {
    change.pull = pull;
  }

  const sha =
    commit(record(pullRequest.head).sha) ??
    commit(checkRun.head_sha) ??
    commit(checkSuite.head_sha) ??
    commit(workflowRun.head_sha) ??
    commit(workflowJob.head_sha) ??
    (kind === "status" ? commit(root.sha) : undefined) ??
    (kind === "push" ? commit(root.after) : undefined);
  if (sha !== undefined) {
    change.sha = sha;
  }

  const run = wholeNumber(workflowRun.id) ?? wholeNumber(workflowJob.run_id);
  if (run !== undefined) {
    change.run = run;
  }

  return change;
}
