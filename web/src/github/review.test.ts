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
