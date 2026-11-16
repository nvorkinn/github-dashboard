import { beforeEach, expect, test, vi } from "vitest";
import { fakeDashboard, pull } from "../components/testing.ts";
import { pullRequest } from "./read.ts";
import { createReviewService } from "./review.ts";
import { fakeGitHub } from "./testing.ts";

vi.mock("./read.ts", () => ({ pullRequest: vi.fn() }));
const current = pull();
const path = `repos/${current.repo}/pulls/${current.number}`;
beforeEach(() => {
  vi.mocked(pullRequest).mockResolvedValue(current);
});
function setup(login = current.author, push = false) {
  const github = fakeGitHub({
    [path]: { body: "Description" },
    [`repos/${current.repo}`]: { permissions: { push } },
    user: { login },
    [`${path}/reviews`]: [],
    [`POST ${path}/reviews`]: {},
  });
  const dashboard = fakeDashboard();
  return { ...github, service: createReviewService(github.auth, dashboard) };
}
test("disables self approval and merge without push permission", async () => {
  const { service } = setup();
  expect(await service.read(current)).toMatchObject({ canApprove: false, canMerge: false, description: "Description" });
});
test("disables actions for drafts and merge when blocked", async () => {
  const { service } = setup("reviewer", true);
  vi.mocked(pullRequest).mockResolvedValue(pull({ draft: true }));
  expect(await service.read(current)).toMatchObject({ canApprove: false, canMerge: false });
  vi.mocked(pullRequest).mockResolvedValue(pull({ mergeState: "blocked" }));
  expect(await service.read(current)).toMatchObject({ canApprove: true, canMerge: false });
});
test("approval pins the displayed commit and never writes after a new push", async () => {
  const { service, requests } = setup("reviewer", true);
  await service.approve(current);
  expect(requests.find((request) => request.method === "POST")?.body).toEqual({
    event: "APPROVE",
    commit_id: current.sha,
  });
  vi.mocked(pullRequest).mockResolvedValue(pull({ sha: "new" }));
  await expect(service.approve(current)).rejects.toThrow(/changed/);
  expect(requests.filter((request) => request.method === "POST")).toHaveLength(1);
});

test("reads which workflow, or app, each check run of the head belongs to", async () => {
  const github = fakeGitHub({
    [path]: { body: "" },
    [`repos/${current.repo}`]: { permissions: { push: false } },
    user: { login: "reviewer" },
    [`${path}/reviews`]: [],
    [`repos/${current.repo}/actions/runs`]: {
      total_count: 2,
      workflow_runs: [
        { name: "CI", check_suite_id: 10 },
        { name: "End-to-end", check_suite_id: 11 },
      ],
    },
    [`repos/${current.repo}/commits/${current.sha}/check-runs`]: {
      total_count: 3,
      check_runs: [
        { html_url: "https://github.com/runs/1", check_suite: { id: 10 }, app: { name: "GitHub Actions" } },
        { html_url: "https://github.com/runs/2", check_suite: { id: 11 }, app: { name: "GitHub Actions" } },
        { html_url: "https://github.com/runs/3", check_suite: { id: 12 }, app: { name: "Vercel" } },
      ],
    },
  });
  const service = createReviewService(github.auth, fakeDashboard());
  expect((await service.read(current)).workflows).toEqual({
    "https://github.com/runs/1": "CI",
    "https://github.com/runs/2": "End-to-end",
    "https://github.com/runs/3": "Vercel",
  });
  expect(github.calls).toContain(`repos/${current.repo}/actions/runs?head_sha=${current.sha}&per_page=100`);
});

test("reads the review without workflows when GitHub won't tell them", async () => {
  const { service } = setup();
  expect((await service.read(current)).workflows).toEqual({});
});
