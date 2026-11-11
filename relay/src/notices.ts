import { commit, pullNumbers, record, text, wholeNumber } from "./payload.ts";

/** One Telegram notice about a webhook: what it says, and what makes another webhook a repeat of it. */
export type Notice = {
  /**
   * What the notice is about, such as `checks:owner/name:<sha>`. A later webhook with the same key is a repeat
   * (GitHub delivering again, another job of the same run waiting, another failed check on the same commit).
   */
  key: string;
  /** Short plain text ending in a link to the thing on github.com. */
  text: string;
  /** For a release waiting for approval: its run on github.com, where Review deployments approves it. */
  review?: string;
};

// Conclusions worth a notice when a pull request's checks finish.
const FAILED = new Set(["failure", "timed_out", "action_required"]);
// Owner and name as GitHub allows them, so a link built from them points where it says.
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const MAX_TITLE = 120;
// A check can name many pull requests (one per branch that has the commit); a notice lists a few.
const MAX_PULLS = 5;

/**
 * What to tell the Telegram chat about a webhook, or nothing when it isn't worth a notice. Only what needs attention
 * gets one, as the dashboard in countdown-server did: a pull request merging or getting changes requested, a pull
 * request's checks failing, and a release run (a workflow whose name says release, promote or deploy, as the page
 * reads it) finishing or waiting for approval.
 *
 * The payload is read as `changeFrom` reads it: a value of an unexpected type counts as missing, and a webhook missing
 * something a notice needs gets none. `delivery` (`X-GitHub-Delivery`) only tells apart reviews that have no id.
 * `dashboard` is the page's address, added as a last line when given.
 */
export function noticeFrom(
  kind: string,
  payload: unknown,
  delivery?: string | undefined,
  dashboard?: string | undefined,
): Notice | undefined {
  const root = record(payload);
  const repo = text(record(root.repository).full_name);
  if (repo === undefined || !REPO.test(repo)) {
    return undefined;
  }
  // hasOwn, so an event named like an object's own property (constructor, toString) finds no rule.
  const found = Object.hasOwn(RULES, kind) ? RULES[kind]?.(repo, root, delivery) : undefined;
  if (!found) {
    return undefined;
  }
  return dashboard ? { ...found, text: `${found.text}\nDashboard: ${dashboard}` } : found;
}

type Rule = (repo: string, root: Record<string, unknown>, delivery: string | undefined) => Notice | undefined;

const RULES: Record<string, Rule> = {
  pull_request: merged,
  pull_request_review: changesRequested,
  check_suite: (repo, root) => checksFailed(repo, root, record(root.check_suite)),
  check_run: (repo, root) => checksFailed(repo, root, record(root.check_run)),
  workflow_run: releaseFinished,
  workflow_job(repo, root) {
    const job = record(root.workflow_job);
    return root.action === "waiting"
      ? releaseWaiting(repo, text(job.workflow_name), wholeNumber(job.run_id), wholeNumber(job.run_attempt))
      : undefined;
  },
  deployment_review(repo, root) {
    const run = record(root.workflow_run);
    return root.action === "requested"
      ? releaseWaiting(repo, text(run.name), wholeNumber(run.id), wholeNumber(run.run_attempt))
      : undefined;
  },
};

function merged(repo: string, root: Record<string, unknown>): Notice | undefined {
  const pull = record(root.pull_request);
  const number = wholeNumber(pull.number);
  if (root.action !== "closed" || pull.merged !== true || number === undefined) {
    return undefined;
  }
  return {
    key: `merged:${repo}#${number}`,
    text: `Merged ${repo}#${number}${titled(pull.title)}\n${pullUrl(repo, number)}`,
  };
}

function changesRequested(repo: string, root: Record<string, unknown>, delivery: string | undefined) {
  const pull = record(root.pull_request);
  const review = record(root.review);
  const number = wholeNumber(pull.number);
  if (root.action !== "submitted" || review.state !== "changes_requested" || number === undefined) {
    return undefined;
  }
  return {
    key: `changes:${repo}#${number}:${wholeNumber(review.id) ?? delivery ?? ""}`,
    text: `Changes requested on ${repo}#${number}${titled(pull.title)}\n${pullUrl(repo, number)}`,
  };
}

/**
 * A check suite or a single check run that failed on a commit some pull request is at. Both come for one failure, as
 * may several suites, so the key is the commit: one notice per commit, however many checks failed on it.
 */
function checksFailed(repo: string, root: Record<string, unknown>, check: Record<string, unknown>) {
  const conclusion = text(check.conclusion);
  const pulls = pullNumbers(check.pull_requests);
  if (root.action !== "completed" || conclusion === undefined || !FAILED.has(conclusion) || pulls.length === 0) {
    return undefined;
  }
  const links = pulls.slice(0, MAX_PULLS).map((number) => pullUrl(repo, number));
  return {
    key: `checks:${repo}:${commit(check.head_sha) ?? pulls.join(",")}`,
    text: `Checks failed in ${repo}\n${links.join("\n")}`,
  };
}

function releaseFinished(repo: string, root: Record<string, unknown>): Notice | undefined {
  const run = record(root.workflow_run);
  const name = text(run.name);
  const id = wholeNumber(run.id);
  if (root.action !== "completed" || !isReleaseName(name) || id === undefined) {
    return undefined;
  }
  return {
    key: `finished:${repo}:${id}:${wholeNumber(run.run_attempt) ?? 1}`,
    text: `${short(name)} in ${repo}: ${text(run.conclusion) ?? "finished"}\n${runUrl(repo, id)}`,
  };
}

/**
 * A release run waiting for someone to approve a deployment. GitHub says so once per waiting job (`workflow_job`,
 * action `waiting`) and once per run (`deployment_review`, action `requested`), so the key is the run's attempt: one
 * notice per wait, however many jobs wait.
 */
function releaseWaiting(
  repo: string,
  name: string | undefined,
  id: number | undefined,
  attempt: number | undefined,
): Notice | undefined {
  if (!isReleaseName(name) || id === undefined) {
    return undefined;
  }
  const run = runUrl(repo, id);
  return {
    key: `waiting:${repo}:${id}:${attempt ?? 1}`,
    text: `A release in ${repo} is waiting for your approval\n${run}`,
    review: run,
  };
}

/** Whether a workflow is a release run, as the page decides it: its name says release, promote or deploy. */
export function isReleaseName(name: string | undefined): name is string {
  const lower = (name ?? "").toLowerCase();
  return lower.includes("release") || lower.includes("promote") || lower.includes("deploy");
}

function titled(value: unknown): string {
  const title = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  return title ? `: ${short(title)}` : "";
}

function short(value: string): string {
  return value.length > MAX_TITLE ? `${value.slice(0, MAX_TITLE - 1)}…` : value;
}

function pullUrl(repo: string, number: number): string {
  return `https://github.com/${repo}/pull/${number}`;
}

function runUrl(repo: string, id: number): string {
  return `https://github.com/${repo}/actions/runs/${id}`;
}
