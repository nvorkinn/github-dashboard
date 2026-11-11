import { expect, test } from "vitest";
import { isReleaseName, noticeFrom, pageNotice } from "./notices.ts";

// The cases come from countdown-server's tests/services/test_github_notify.py, with the same texts.
const SHA = "0123456789abcdef0123456789abcdef01234567";
const repository = { full_name: "nvorkinn/countdown" };
const pull = { number: 7, title: "Add parcels", html_url: "https://github.com/nvorkinn/countdown/pull/7" };
const PULL_URL = "https://github.com/nvorkinn/countdown/pull/7";
const MERGED = { action: "closed", repository, pull_request: { ...pull, merged: true } };

test("a merge is named with its link", () => {
  expect(noticeFrom("pull_request", MERGED)).toEqual({
    type: "merged",
    repo: "nvorkinn/countdown",
    headline: "Merged nvorkinn/countdown#7: Add parcels",
    url: PULL_URL,
    key: "merged:nvorkinn/countdown#7",
    text: `Merged nvorkinn/countdown#7: Add parcels\n${PULL_URL}`,
  });
});

test("a closed pull request that didn't merge, and other actions, are quiet", () => {
  expect(noticeFrom("pull_request", { ...MERGED, pull_request: { ...pull, merged: false } })).toBeUndefined();
  expect(noticeFrom("pull_request", { ...MERGED, action: "opened" })).toBeUndefined();
});

test("requested changes are sent but approvals are not", () => {
  const review = { action: "submitted", repository, pull_request: pull };
  expect(noticeFrom("pull_request_review", { ...review, review: { id: 55, state: "changes_requested" } })).toEqual({
    type: "changes",
    repo: "nvorkinn/countdown",
    headline: "Changes requested on nvorkinn/countdown#7: Add parcels",
    url: PULL_URL,
    key: "changes:nvorkinn/countdown#7:55",
    text: `Changes requested on nvorkinn/countdown#7: Add parcels\n${PULL_URL}`,
  });
  expect(noticeFrom("pull_request_review", { ...review, review: { id: 56, state: "approved" } })).toBeUndefined();
  expect(noticeFrom("pull_request_review", { ...review, review: { state: "commented" } })).toBeUndefined();
  // A review with no id is told apart by its delivery.
  const noId = noticeFrom("pull_request_review", { ...review, review: { state: "changes_requested" } }, "d-1");
  expect(noId?.key).toBe("changes:nvorkinn/countdown#7:d-1");
});

test.each([
  ["failure", true],
  ["timed_out", true],
  ["action_required", true],
  ["success", false],
  ["cancelled", false],
  ["neutral", false],
])("only failed checks on a pull request are sent: %s", (conclusion, sent) => {
  for (const kind of ["check_suite", "check_run"]) {
    const check = { conclusion, head_sha: SHA, pull_requests: [{ number: 7 }] };
    const notice = noticeFrom(kind, { action: "completed", repository, [kind]: check });
    if (sent) {
      // A suite and a run on the same commit have the same key, so the second is a repeat.
      expect(notice, kind).toEqual({
        type: "checks",
        repo: "nvorkinn/countdown",
        headline: "Checks failed in nvorkinn/countdown",
        url: PULL_URL,
        key: `checks:nvorkinn/countdown:${SHA}`,
        text: `Checks failed in nvorkinn/countdown\n${PULL_URL}`,
      });
    } else {
      expect(notice, kind).toBeUndefined();
    }
  }
});

test("failed checks with no pull request, or not completed, are quiet", () => {
  const suite = { conclusion: "failure", head_sha: SHA, pull_requests: [] };
  expect(noticeFrom("check_suite", { action: "completed", repository, check_suite: suite })).toBeUndefined();
  const run = { conclusion: "failure", head_sha: SHA, pull_requests: [{ number: 7 }] };
  expect(noticeFrom("check_run", { action: "rerequested", repository, check_run: run })).toBeUndefined();
});

test("failed checks list each pull request the commit is at", () => {
  const suite = { conclusion: "failure", pull_requests: [{ number: 7 }, { number: "8" }, { number: 9 }] };
  expect(noticeFrom("check_suite", { action: "completed", repository, check_suite: suite })).toEqual({
    type: "checks",
    repo: "nvorkinn/countdown",
    headline: "Checks failed in nvorkinn/countdown",
    url: PULL_URL,
    key: "checks:nvorkinn/countdown:7,9",
    text: `Checks failed in nvorkinn/countdown\n${PULL_URL}\nhttps://github.com/nvorkinn/countdown/pull/9`,
  });
});

test("a finished release says how it went, but other runs are quiet", () => {
  const run = { id: 1, name: "Release", conclusion: "failure", run_attempt: 2, html_url: "https://example.com/" };
  const payload = { action: "completed", repository, workflow_run: run };
  expect(noticeFrom("workflow_run", payload)).toEqual({
    type: "release",
    repo: "nvorkinn/countdown",
    headline: "Release in nvorkinn/countdown: failure",
    url: "https://github.com/nvorkinn/countdown/actions/runs/1",
    key: "finished:nvorkinn/countdown:1:2",
    text: "Release in nvorkinn/countdown: failure\nhttps://github.com/nvorkinn/countdown/actions/runs/1",
  });
  expect(noticeFrom("workflow_run", { ...payload, workflow_run: { ...run, name: "Test" } })).toBeUndefined();
  expect(noticeFrom("workflow_run", { ...payload, action: "in_progress" })).toBeUndefined();
  // A workflow GitHub runs by itself has no file in the repository, and is no release whatever its name.
  const pages = { id: 3, name: "pages build and deployment", path: "dynamic/pages/pages-build-deployment" };
  expect(noticeFrom("workflow_run", { ...payload, workflow_run: pages })).toBeUndefined();
  const filed = { ...run, path: ".github/workflows/release.yml" };
  expect(noticeFrom("workflow_run", { ...payload, workflow_run: filed })).toBeDefined();
  const promote = noticeFrom("workflow_run", { ...payload, workflow_run: { id: 2, name: "Promote to prod" } });
  expect(promote?.text).toBe(
    "Promote to prod in nvorkinn/countdown: finished\nhttps://github.com/nvorkinn/countdown/actions/runs/2",
  );
});

test("a release waiting for approval is told by its deployment review, and links its run", () => {
  const run = "https://github.com/nvorkinn/countdown/actions/runs/99";
  const expected = {
    type: "waiting",
    repo: "nvorkinn/countdown",
    headline: "A release in nvorkinn/countdown is waiting for your approval",
    url: run,
    key: "waiting:nvorkinn/countdown:99:1",
    text: `A release in nvorkinn/countdown is waiting for your approval\n${run}`,
    review: run,
  };
  const review = { action: "requested", repository, workflow_run: { id: 99, name: "Release", run_attempt: 1 } };
  expect(noticeFrom("deployment_review", review)).toEqual(expected);

  expect(noticeFrom("deployment_review", { ...review, action: "approved" })).toBeUndefined();
  const test = { ...review, workflow_run: { ...review.workflow_run, name: "Test" } };
  expect(noticeFrom("deployment_review", test)).toBeUndefined();
  // A job is also waiting while it has no runner yet, so a waiting job says nothing about an approval.
  const job = { id: 5, workflow_name: "Release", run_id: 99, run_attempt: 1 };
  expect(noticeFrom("workflow_job", { action: "waiting", repository, workflow_job: job })).toBeUndefined();
});

test("a page is told only what its desktop notification shows", () => {
  const notice = noticeFrom("pull_request", MERGED, undefined, "https://github.vorkinn.org");
  expect(notice && pageNotice(notice)).toEqual({
    type: "merged",
    key: "merged:nvorkinn/countdown#7",
    repo: "nvorkinn/countdown",
    headline: "Merged nvorkinn/countdown#7: Add parcels",
    url: PULL_URL,
  });
});

test("the dashboard's address goes on a last line when it is known", () => {
  expect(noticeFrom("pull_request", MERGED, undefined, "https://github.vorkinn.org")?.text).toBe(
    `Merged nvorkinn/countdown#7: Add parcels\n${PULL_URL}\nDashboard: https://github.vorkinn.org`,
  );
});

test("a long or odd title is cut down to one short line, and a missing one left out", () => {
  const long = noticeFrom("pull_request", {
    ...MERGED,
    pull_request: { ...pull, merged: true, title: "x".repeat(300) },
  });
  expect(long?.text).toBe(`Merged nvorkinn/countdown#7: ${"x".repeat(119)}…\n${PULL_URL}`);
  const lines = noticeFrom("pull_request", { ...MERGED, pull_request: { ...pull, merged: true, title: " a\n\nb " } });
  expect(lines?.text).toBe(`Merged nvorkinn/countdown#7: a b\n${PULL_URL}`);
  const none = noticeFrom("pull_request", { ...MERGED, pull_request: { number: 7, merged: true, title: 5 } });
  expect(none?.text).toBe(`Merged nvorkinn/countdown#7\n${PULL_URL}`);
});

test.each<[string, string, unknown]>([
  ["no payload", "pull_request", null],
  ["no repository", "pull_request", { ...MERGED, repository: undefined }],
  ["a repository name that isn't owner/name", "pull_request", { ...MERGED, repository: { full_name: "x/../y z" } }],
  ["a repository of the wrong type", "pull_request", { ...MERGED, repository: "nvorkinn/countdown" }],
  ["no pull request", "pull_request", { action: "closed", repository }],
  ["merged that isn't true", "pull_request", { ...MERGED, pull_request: { number: 7, merged: "true" } }],
  ["a pull number of the wrong type", "pull_request", { ...MERGED, pull_request: { number: "7", merged: true } }],
  ["no review", "pull_request_review", { action: "submitted", repository, pull_request: pull }],
  [
    "checks that are no list",
    "check_suite",
    { action: "completed", repository, check_suite: { conclusion: "failure", pull_requests: "7" } },
  ],
  ["a run with no id", "workflow_run", { action: "completed", repository, workflow_run: { name: "Release" } }],
  ["a review with no run", "deployment_review", { action: "requested", repository, workflow_run: { name: "Release" } }],
  ["an event with no rule", "push", { ...MERGED }],
  ["an event named like an object's property", "constructor", { ...MERGED }],
])("an odd payload sends nothing and throws nothing: %s", (_name, kind, payload) => {
  expect(noticeFrom(kind, payload)).toBeUndefined();
});

test("a release run is one whose name says release, promote or deploy", () => {
  expect(["Release", "Deploy to prod", "PROMOTE"].every((name) => isReleaseName(name))).toBe(true);
  expect(["CI", "Tests", "", undefined].some((name) => isReleaseName(name))).toBe(false);
});
