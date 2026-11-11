import { expect, test } from "vitest";
import { createApi, GitHubError } from "./api.ts";
import { checkState, checks, isReleaseName, mergeState, readDashboard, shownRuns } from "./read.ts";
import { account, fakeGitHub, job, repo, withPull, withWorkflow } from "./testing.ts";

function read(routes: Record<string, unknown>, previous?: Parameters<typeof readDashboard>[1]) {
  const github = fakeGitHub(routes);
  return { ...github, result: readDashboard(createApi(github.auth), previous) };
}

test.each([
  ["queued", null, "queued"],
  ["requested", null, "queued"],
  ["pending", null, "queued"],
  ["in_progress", null, "running"],
  ["waiting", null, "waiting"],
  ["completed", "success", "passed"],
  ["completed", "failure", "failed"],
  ["completed", "timed_out", "failed"],
  ["completed", "startup_failure", "failed"],
  ["completed", "action_required", "failed"],
  ["completed", "stale", "failed"],
  ["completed", "cancelled", "cancelled"],
  ["completed", "skipped", "skipped"],
  ["completed", "neutral", "neutral"],
])("a check, run or job that is %s with conclusion %s is %s", (status, conclusion, state) => {
  expect(checkState(status, conclusion)).toBe(state);
});

test.each([
  [true, "clean", "clean"],
  [true, "has_hooks", "clean"],
  // Mergeable, with failing checks that aren't required.
  [true, "unstable", "clean"],
  [false, "dirty", "conflicts"],
  [true, "behind", "behind"],
  [true, "blocked", "blocked"],
  [true, "draft", "blocked"],
  [null, "unknown", "unknown"],
  // Still being worked out, whatever the state said last.
  [null, "clean", "unknown"],
  [true, "something new", "unknown"],
])("mergeable %s and %s is %s", (mergeable, mergeable_state, state) => {
  expect(mergeState({ mergeable, mergeable_state })).toBe(state);
});

test("checks are the check runs and then the newest status of each context", () => {
  expect(
    checks(
      [
        {
          name: "test",
          status: "completed",
          conclusion: "success",
          html_url: "https://github.com/octo/app/runs/1",
        },
        { name: "deploy", status: "waiting", conclusion: null, html_url: null },
      ],
      [
        { context: "ci/build", state: "success", target_url: "https://ci.example/2" },
        { context: "ci/build", state: "pending", target_url: "https://ci.example/2" },
        { context: "ci/lint", state: "pending", target_url: null },
        { context: "ci/scan", state: "error", target_url: null },
        { context: "ci/scan", state: "success", target_url: null },
        { context: "ci/docs", state: "failure", target_url: null },
      ],
    ),
  ).toEqual([
    { name: "test", state: "passed", url: "https://github.com/octo/app/runs/1" },
    { name: "deploy", state: "waiting", url: undefined },
    { name: "ci/build", state: "passed", url: "https://ci.example/2" },
    { name: "ci/lint", state: "running", url: undefined },
    { name: "ci/scan", state: "failed", url: undefined },
    { name: "ci/docs", state: "failed", url: undefined },
  ]);
});

test.each([
  ["Release", true],
  ["Publish release notes", true],
  ["DEPLOY to production", true],
  ["Promote", true],
  ["CI", false],
  ["Preview", false],
  [null, false],
])("a workflow named %s is a release: %s", (name, expected) => {
  expect(isReleaseName(name)).toBe(expected);
});

test("of a workflow's runs, the unfinished ones and the latest finished one are shown", () => {
  const runs = [
    { id: 5, status: "queued" },
    { id: 4, status: "completed" },
    { id: 3, status: "in_progress" },
    { id: 2, status: "completed" },
  ];
  expect(shownRuns(runs).map((run) => run.id)).toEqual([5, 3, 4]);
  expect(shownRuns([])).toEqual([]);
});

test("projects are the installations' repositories, without archived ones, the last pushed first", async () => {
  const routes = {
    "user/installations": { total_count: 2, installations: [{ id: 7 }, { id: 8 }] },
    "user/installations/7/repositories": {
      total_count: 2,
      repositories: [
        repo("octo/old", { pushed_at: "2026-01-01T00:00:00Z", description: null }),
        repo("octo/archived", { archived: true }),
      ],
    },
    "user/installations/8/repositories": {
      total_count: 2,
      repositories: [
        repo("acme/new", { pushed_at: "2026-11-10T00:00:00Z", private: true, default_branch: "trunk" }),
        repo("acme/empty", { pushed_at: null }),
      ],
    },
    "repos/acme/new/releases/latest": {
      tag_name: "v2.1.0",
      html_url: "https://github.com/acme/new/releases/tag/v2.1.0",
      created_at: "2026-11-09T00:00:00Z",
      published_at: "2026-11-09T10:00:00Z",
    },
    "repos/octo/old/pulls": [],
    "repos/octo/old/actions/workflows": { total_count: 0, workflows: [] },
    "repos/acme/new/pulls": [],
    "repos/acme/new/actions/workflows": { total_count: 0, workflows: [] },
    "repos/acme/empty/pulls": [],
    "repos/acme/empty/actions/workflows": { total_count: 0, workflows: [] },
  };
  const { data, problem } = await read(routes).result;
  expect(problem).toBeUndefined();
  expect(data.projects).toEqual([
    {
      repo: "acme/new",
      name: "new",
      description: "A sample",
      url: "https://github.com/acme/new",
      defaultBranch: "trunk",
      private: true,
      pushedAt: "2026-11-10T00:00:00Z",
      latestRelease: {
        tag: "v2.1.0",
        url: "https://github.com/acme/new/releases/tag/v2.1.0",
        publishedAt: "2026-11-09T10:00:00Z",
      },
    },
    {
      repo: "octo/old",
      name: "old",
      description: undefined,
      url: "https://github.com/octo/old",
      defaultBranch: "main",
      private: false,
      pushedAt: "2026-01-01T00:00:00Z",
      // A 404 from releases/latest.
      latestRelease: undefined,
    },
    expect.objectContaining({ repo: "acme/empty", pushedAt: undefined }),
  ]);
});

test("a pull request is read with its merge state and checks", async () => {
  const routes = account("octo/app");
  withPull(routes, "octo/app", 12, {
    pull: { mergeable_state: "blocked", auto_merge: { merge_method: "squash" }, draft: true },
    checkRuns: [{ name: "test", status: "in_progress", conclusion: null, html_url: "https://github.com/r/1" }],
    statuses: [{ context: "ci/build", state: "success", target_url: null }],
  });
  // The list's entry has no mergeability; only the pull request's own page does.
  routes["repos/octo/app/pulls"] = [{ number: 12 }];
  const { result, calls } = read(routes);
  expect((await result).data.pulls).toEqual([
    {
      repo: "octo/app",
      number: 12,
      title: "Change 12",
      url: "https://github.com/octo/app/pull/12",
      author: "octocat",
      authorAvatarUrl: "https://avatars.githubusercontent.com/u/583231",
      draft: true,
      head: "change-12",
      base: "main",
      sha: "sha12",
      createdAt: "2026-11-02T08:00:00Z",
      updatedAt: "2026-11-02T09:00:00Z",
      mergeState: "blocked",
      autoMerge: true,
      checks: [
        { name: "test", state: "running", url: "https://github.com/r/1" },
        { name: "ci/build", state: "passed", url: undefined },
      ],
    },
  ]);
  expect(calls).toContain("repos/octo/app/pulls?state=open&per_page=100");
  expect(calls).toContain("repos/octo/app/commits/sha12/check-runs?filter=latest&per_page=100");
  expect(calls).toContain("repos/octo/app/commits/sha12/statuses?per_page=100");
});

test("a pull request that closed or went away while being read is left out", async () => {
  const routes = account("octo/app");
  withPull(routes, "octo/app", 1, { pull: { state: "closed" } });
  withPull(routes, "octo/app", 2);
  withPull(routes, "octo/app", 3);
  delete routes["repos/octo/app/pulls/3"];
  const { data, problem } = await read(routes).result;
  expect(data.pulls.map((pull) => pull.number)).toEqual([2]);
  expect(problem).toBeUndefined();
});

test("releases are the active release workflows' unfinished runs and last finished one, with their jobs", async () => {
  const routes = account("octo/app");
  withWorkflow(routes, "octo/app", { id: 1, name: "CI" }, [{ id: 9 }]);
  withWorkflow(routes, "octo/app", { id: 2, name: "Old deploy", state: "disabled_manually" }, [{ id: 8 }]);
  withWorkflow(routes, "octo/app", { id: 3, name: "Release" }, [
    {
      id: 4,
      status: "in_progress",
      conclusion: null,
      triggering_actor: { login: "hubot" },
      jobs: [
        job(41),
        job(42, { status: "waiting", conclusion: null, completed_at: null }),
        job(43, { status: "queued", conclusion: null, completed_at: null }),
        job(44, { status: "in_progress", conclusion: null, completed_at: null }),
      ],
    },
    { id: 3, conclusion: "failure", jobs: [job(31, { conclusion: "failure" }), job(32, { conclusion: "skipped" })] },
    { id: 2 },
  ]);
  withWorkflow(routes, "octo/app", { id: 4, name: "Promote" }, [{ id: 1, display_title: undefined }]);

  const { result, calls } = read(routes);
  const { data } = await result;
  expect(data.releases).toEqual([
    {
      repo: "octo/app",
      id: 4,
      workflow: "Release",
      title: "v1.0.4",
      url: "https://github.com/octo/app/actions/runs/4",
      // In progress to GitHub, but a job is waiting for approval.
      state: "waiting",
      actor: "hubot",
      startedAt: "2026-11-04T12:00:05Z",
      finishedAt: undefined,
      jobs: [
        {
          id: 41,
          name: "job 41",
          state: "passed",
          url: "https://github.com/octo/app/actions/runs/1/job/41",
          startedAt: "2026-11-01T12:00:10Z",
          finishedAt: "2026-11-01T12:05:00Z",
        },
        expect.objectContaining({ id: 42, state: "waiting", startedAt: undefined, finishedAt: undefined }),
        expect.objectContaining({ id: 43, state: "queued", startedAt: undefined, finishedAt: undefined }),
        expect.objectContaining({ id: 44, state: "running", startedAt: "2026-11-01T12:00:10Z" }),
      ],
    },
    expect.objectContaining({
      id: 3,
      state: "failed",
      finishedAt: "2026-11-03T12:10:00Z",
      jobs: [expect.objectContaining({ state: "failed" }), expect.objectContaining({ state: "skipped" })],
    }),
    expect.objectContaining({ id: 1, workflow: "Promote", title: "Promote", state: "passed", actor: "octocat" }),
  ]);
  expect(calls).toContain("repos/octo/app/actions/workflows/3/runs?per_page=5");
  expect(calls).toContain("repos/octo/app/actions/runs/4/jobs?per_page=100");
  // Not the CI workflow's runs, the disabled workflow's, or the jobs of the older finished release.
  expect(calls.filter((call) => /workflows\/[12]\/runs|runs\/[289]\/jobs/.test(call))).toEqual([]);
});

test("a project that can't be read keeps what was read before, and the others are read", async () => {
  const routes = account("octo/app", "octo/broken", "octo/worse");
  withPull(routes, "octo/app", 1);
  withPull(routes, "octo/broken", 2);
  withWorkflow(routes, "octo/broken", { id: 1, name: "Release" }, [{ id: 5 }]);
  const before = (await read(routes).result).data;
  expect(before.pulls.map((pull) => pull.repo)).toEqual(["octo/app", "octo/broken"]);

  routes["repos/octo/broken/pulls"] = () => new Response(null, { status: 502 });
  routes["repos/octo/broken/actions/workflows"] = () => Response.json({ message: "no" }, { status: 403 });
  withPull(routes, "octo/app", 3);

  const first = await read(routes).result;
  expect(first.problem).toBe("Couldn't read everything from octo/broken.");
  expect(first.data.projects).toHaveLength(3);
  expect(first.data.pulls.map((pull) => pull.number)).toEqual([1, 3]);
  expect(first.data.releases).toEqual([]);

  const later = await read(routes, before).result;
  expect(later.data.pulls.map((pull) => pull.number)).toEqual([1, 3, 2]);
  expect(later.data.releases.map((run) => run.id)).toEqual([5]);

  routes["repos/octo/worse/releases/latest"] = () => new Response(null, { status: 500 });
  expect((await read(routes).result).problem).toBe("Couldn't read everything from 2 projects.");
});

test.each([
  ["a rate limit", () => Response.json({}, { status: 403, headers: { "retry-after": "60" } }), 403],
  ["a sign-in GitHub no longer accepts", () => new Response(null, { status: 401 }), 401],
])("%s in one project fails the whole read", async (_, answer, status) => {
  const routes = account("octo/app", "octo/other");
  routes["repos/octo/other/pulls"] = answer;
  const error = await read(routes).result.catch((thrown: unknown) => thrown);
  expect(error).toBeInstanceOf(GitHubError);
  expect(error).toMatchObject({ status });
});

test("a network that fails in one project fails the whole read", async () => {
  const routes = account("octo/app");
  routes["repos/octo/app/pulls"] = () => {
    throw new TypeError("Failed to fetch");
  };
  await expect(read(routes).result).rejects.toThrow("Failed to fetch");
});
