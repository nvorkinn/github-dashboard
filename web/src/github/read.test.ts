import { expect, test } from "vitest";
import { project, pull } from "../components/testing.ts";
import type { DashboardData } from "../model.ts";
import { createApi, GitHubError } from "./api.ts";
import type { Change } from "./events.ts";
import {
  checkState,
  checks,
  isReleaseName,
  mergeMethod,
  mergeState,
  type Plan,
  PROMOTE_WORKFLOW,
  planFor,
  readChanged,
  readDashboard,
  shownRuns,
} from "./read.ts";
import { account, fakeGitHub, job, type Routes, repo, run, withPull, withWorkflow } from "./testing.ts";

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
    // Its own page has its merge settings; octo/old's can't be read, and counts as allowing everything.
    "repos/acme/new": repo("acme/new", {
      allow_merge_commit: false,
      allow_squash_merge: true,
      allow_rebase_merge: true,
      allow_auto_merge: false,
    }),
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
      mergeMethod: "squash",
      autoMergeAllowed: false,
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
      mergeMethod: "merge",
      autoMergeAllowed: true,
    },
    expect.objectContaining({ repo: "acme/empty", pushedAt: undefined }),
  ]);
});

test.each([
  [{}, "merge"],
  [{ allow_merge_commit: false }, "squash"],
  [{ allow_merge_commit: false, allow_squash_merge: false }, "rebase"],
  [{ allow_merge_commit: true, allow_squash_merge: false, allow_rebase_merge: false }, "merge"],
  // GitHub doesn't allow turning all three off, but if it said so, a merge commit is what it would be asked for.
  [{ allow_merge_commit: false, allow_squash_merge: false, allow_rebase_merge: false }, "merge"],
] as const)("the merge method of %j is %s: the first allowed, a merge commit first", (settings, method) => {
  expect(mergeMethod(settings)).toBe(method);
});

test("merge settings in the list of repositories are used as they are, without reading each repository", async () => {
  const routes = account("octo/app");
  const settings = { allow_merge_commit: false, allow_squash_merge: false, allow_rebase_merge: true };
  routes["user/installations/7/repositories"] = {
    total_count: 1,
    repositories: [repo("octo/app", { ...settings, allow_auto_merge: true })],
  };
  const { result, calls } = read(routes);
  expect((await result).data.projects[0]).toMatchObject({ mergeMethod: "rebase", autoMergeAllowed: true });
  expect(calls).not.toContain("repos/octo/app");
});

test("merge settings that can't be read again stay as they were, and are no problem", async () => {
  const routes = account("octo/app");
  const before = (await read(routes).result).data;
  const earlier = { ...before, projects: before.projects.map((one) => ({ ...one, mergeMethod: "squash" as const })) };
  routes["repos/octo/app"] = () => Response.json({ message: "Not Found" }, { status: 404 });
  const { data, problem } = await read(routes, earlier).result;
  expect(problem).toBeUndefined();
  expect(data.projects[0]).toMatchObject({ mergeMethod: "squash", autoMergeAllowed: true });
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
      nodeId: "PR_node12",
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
  routes["repos/octo/app/actions/runs/4/pending_deployments"] = [
    {
      environment: { id: 70, name: "production" },
      wait_timer: 0,
      current_user_can_approve: true,
      reviewers: [],
    },
    { environment: { id: 71, name: "billing" }, wait_timer: 5, current_user_can_approve: false, reviewers: [] },
  ];

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
      approvals: [
        { environmentId: 70, environment: "production", canApprove: true },
        { environmentId: 71, environment: "billing", canApprove: false },
      ],
    },
    expect.objectContaining({
      id: 3,
      state: "failed",
      finishedAt: "2026-11-03T12:10:00Z",
      jobs: [expect.objectContaining({ state: "failed" }), expect.objectContaining({ state: "skipped" })],
      approvals: [],
    }),
    expect.objectContaining({ id: 1, workflow: "Promote", title: "Promote", state: "passed", actor: "octocat" }),
  ]);
  expect(calls).toContain("repos/octo/app/actions/workflows/3/runs?per_page=5");
  expect(calls).toContain("repos/octo/app/actions/runs/4/jobs?per_page=100");
  // Not the CI workflow's runs, the disabled workflow's, or the jobs of the older finished release.
  expect(calls.filter((call) => /workflows\/[12]\/runs|runs\/[289]\/jobs/.test(call))).toEqual([]);
  // What waits for an approval is asked only of the run that waits.
  expect(calls.filter((call) => call.includes("pending_deployments"))).toEqual([
    "repos/octo/app/actions/runs/4/pending_deployments?per_page=100",
  ]);
  // No workflow is at promote.yml.
  expect(data.projects[0]?.promoteWorkflow).toBeUndefined();
});

test("a waiting run whose approvals GitHub won't show has none, and still shows", async () => {
  const routes = account("octo/app");
  withWorkflow(routes, "octo/app", { id: 3, name: "Release" }, [
    { id: 4, status: "waiting", conclusion: null, jobs: [job(42, { status: "waiting", conclusion: null })] },
  ]);
  routes["repos/octo/app/actions/runs/4/pending_deployments"] = () => Response.json({}, { status: 403 });
  const { data, problem } = await read(routes).result;
  expect(data.releases).toEqual([expect.objectContaining({ id: 4, state: "waiting", approvals: [] })]);
  expect(problem).toBeUndefined();
});

test("a project's Promote workflow is the active one at promote.yml, found in the same list of workflows", async () => {
  const routes = account("octo/app", "octo/off", "octo/none");
  withWorkflow(routes, "octo/app", { id: 1, name: "CI" }, []);
  withWorkflow(routes, "octo/app", { id: 6, name: "Ship to prod", path: PROMOTE_WORKFLOW }, []);
  withWorkflow(routes, "octo/off", { id: 7, name: "Promote", state: "disabled_manually", path: PROMOTE_WORKFLOW }, []);
  withWorkflow(routes, "octo/none", { id: 8, name: "Promote" }, []);
  const { result, calls } = read(routes);
  const { data } = await result;
  expect(data.projects.map((one) => [one.repo, one.promoteWorkflow])).toEqual([
    ["octo/app", 6],
    ["octo/off", undefined],
    ["octo/none", undefined],
  ]);
  expect(calls.filter((call) => call.includes("actions/workflows/6"))).toEqual([]);

  // A read of the release runs reads it again; a read of something else keeps it.
  routes["repos/octo/app/actions/workflows"] = { total_count: 0, workflows: [] };
  const kept = await changed(routes, [{ kind: "release", repo: "octo/app" }], data);
  expect(kept.data.projects[0]?.promoteWorkflow).toBe(6);
  const gone = await changed(routes, [{ kind: "workflow_run", repo: "octo/app", run: 1 }], data);
  expect(gone.data.projects[0]?.promoteWorkflow).toBeUndefined();
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

// What is known when the changes below arrive: two projects, and two pull requests whose heads are the same commit.
const known: DashboardData = {
  projects: [project({ repo: "octo/app" }), project({ repo: "octo/lib" })],
  pulls: [
    pull({ repo: "octo/app", number: 1, sha: "sha1" }),
    pull({ repo: "octo/app", number: 2, sha: "sha2" }),
    pull({ repo: "octo/lib", number: 5, sha: "sha1" }),
  ],
  releases: [],
};

/** A plan, spelled with only what it reads. */
function plan(repos: Record<string, { pulls?: "all" | number[]; releases?: true; latestRelease?: true }>): Plan {
  return new Map(
    Object.entries(repos).map(([name, wanted]) => [
      name,
      {
        pulls: wanted.pulls === "all" ? "all" : new Set(wanted.pulls ?? []),
        releases: wanted.releases ?? false,
        latestRelease: wanted.latestRelease ?? false,
      },
    ]),
  );
}

test.each<[string, Change[], Plan]>([
  [
    "a pull request, also one not known yet",
    [{ kind: "pull_request", repo: "octo/app", action: "opened", pull: 7 }],
    plan({ "octo/app": { pulls: [7] } }),
  ],
  [
    "a review",
    [{ kind: "pull_request_review", repo: "octo/app", pull: 1, sha: "sha1" }],
    plan({ "octo/app": { pulls: [1] } }),
  ],
  [
    "a check on a pull request's head",
    [{ kind: "check_run", repo: "octo/app", sha: "sha2" }],
    plan({ "octo/app": { pulls: [2] } }),
  ],
  [
    "a status on a commit that is a head in another project too",
    [{ kind: "status", repo: "octo/app", sha: "sha1" }],
    plan({ "octo/app": { pulls: [1] } }),
  ],
  [
    "a check on a commit no pull request has as its head",
    [{ kind: "check_run", repo: "octo/app", sha: "main1" }],
    plan({}),
  ],
  ["a check that names no commit", [{ kind: "check_suite", repo: "octo/app" }], plan({ "octo/app": { pulls: "all" } })],
  [
    "a workflow's job on the default branch",
    [{ kind: "workflow_job", repo: "octo/app", sha: "main1", run: 9 }],
    plan({ "octo/app": { releases: true } }),
  ],
  [
    "a workflow run on a pull request",
    [{ kind: "workflow_run", repo: "octo/lib", sha: "sha1", run: 9 }],
    plan({ "octo/lib": { releases: true, pulls: [5] } }),
  ],
  [
    "an approval of a deployment",
    [{ kind: "deployment_review", repo: "octo/app", run: 9 }],
    plan({ "octo/app": { releases: true, pulls: "all" } }),
  ],
  ["a push", [{ kind: "push", repo: "octo/app", sha: "main2" }], plan({ "octo/app": { pulls: "all" } })],
  ["a release", [{ kind: "release", repo: "octo/lib" }], plan({ "octo/lib": { latestRelease: true } })],
  [
    "a burst",
    [
      { kind: "check_run", repo: "octo/app", sha: "sha1" },
      { kind: "check_run", repo: "octo/app", sha: "sha2" },
      { kind: "check_run", repo: "octo/app", sha: "sha2" },
      { kind: "release", repo: "octo/app" },
      { kind: "workflow_job", repo: "octo/lib", sha: "sha1" },
      { kind: "check_run", repo: "octo/lib", sha: "main1" },
    ],
    plan({ "octo/app": { pulls: [1, 2], latestRelease: true }, "octo/lib": { releases: true, pulls: [5] } }),
  ],
  [
    "a push among checks",
    [
      { kind: "check_run", repo: "octo/app", sha: "sha1" },
      { kind: "push", repo: "octo/app" },
      { kind: "check_run", repo: "octo/app", pull: 2 },
    ],
    plan({ "octo/app": { pulls: "all" } }),
  ],
  ["a repository that changed", [{ kind: "repository", repo: "octo/app", action: "archived" }], "everything"],
  ["an installation", [{ kind: "installation", action: "created" }], "everything"],
  ["repositories added", [{ kind: "installation_repositories", action: "added" }], "everything"],
  ["a kind that isn't known", [{ kind: "star", repo: "octo/app" }], plan({})],
  ["a kind that isn't known and names no repository", [{ kind: "github_app_authorization" }], plan({})],
  ["a change without a repository", [{ kind: "check_run", sha: "sha1" }], "everything"],
  ["a repository that isn't known", [{ kind: "pull_request", repo: "octo/new", pull: 1 }], "everything"],
  [
    "one such among others",
    [
      { kind: "check_run", repo: "octo/app", sha: "sha1" },
      { kind: "repository", repo: "octo/lib" },
    ],
    "everything",
  ],
  ["nothing", [], plan({})],
])("the plan for %s", (_, changes, expected) => {
  expect(planFor(changes, known)).toEqual(expected);
});

/** An account with something of everything, and what a read of all of it gives. */
async function everything() {
  const routes = account("octo/app", "octo/lib");
  withPull(routes, "octo/app", 1);
  withPull(routes, "octo/app", 2);
  withPull(routes, "octo/lib", 5);
  withWorkflow(routes, "octo/app", { id: 3, name: "Release" }, [{ id: 4, jobs: [job(41)] }]);
  routes["repos/octo/app/releases/latest"] = {
    tag_name: "v1.0.0",
    html_url: "https://github.com/octo/app/releases/tag/v1.0.0",
    created_at: "2026-11-01T00:00:00Z",
    published_at: "2026-11-01T10:00:00Z",
  };
  return { routes, before: (await read(routes).result).data };
}

/** Reads what `changes` name. `calls` are the requests that took, sorted. */
async function changed(routes: Routes, changes: Change[], before: DashboardData) {
  const wanted = planFor(changes, before);
  if (wanted === "everything") {
    throw new Error("These changes read everything");
  }
  const github = fakeGitHub(routes);
  const result = await readChanged(createApi(github.auth), wanted, before);
  return { ...result, calls: github.calls.sort() };
}

const pullCalls = (repo: string, number: number) => [
  `repos/${repo}/commits/sha${number}/check-runs?filter=latest&per_page=100`,
  `repos/${repo}/commits/sha${number}/statuses?per_page=100`,
  `repos/${repo}/pulls/${number}`,
];

test("a check on a pull request reads that pull request and nothing else", async () => {
  const { routes, before } = await everything();
  routes["repos/octo/app/commits/sha2/check-runs"] = {
    total_count: 1,
    check_runs: [{ name: "test", status: "in_progress", conclusion: null, html_url: null }],
  };
  const { data, problem, calls } = await changed(
    routes,
    [{ kind: "check_run", repo: "octo/app", sha: "sha2" }],
    before,
  );
  expect(calls).toEqual(pullCalls("octo/app", 2));
  expect(problem).toBeUndefined();
  expect(data.pulls.map((one) => one.number)).toEqual([1, 2, 5]);
  expect(data.pulls[1]).toEqual({ ...before.pulls[1], checks: [{ name: "test", state: "running", url: undefined }] });
  // The rest is what it was, to the object.
  expect(data.pulls[0]).toBe(before.pulls[0]);
  expect(data.pulls[2]).toBe(before.pulls[2]);
  expect(data.projects).toEqual(before.projects);
  expect(data.releases).toEqual(before.releases);
});

test("a check on a commit that is no pull request's head reads nothing", async () => {
  const { routes, before } = await everything();
  const { data, calls } = await changed(routes, [{ kind: "check_run", repo: "octo/app", sha: "main1" }], before);
  expect(calls).toEqual([]);
  expect(data).toEqual(before);
});

test("pull requests read by number are changed, added at the front, or gone", async () => {
  const { routes, before } = await everything();
  withPull(routes, "octo/app", 8);
  withPull(routes, "octo/app", 9);
  routes["repos/octo/app/pulls/1"] = { ...(routes["repos/octo/app/pulls/1"] as object), state: "closed" };
  routes["repos/octo/app/pulls/2"] = { ...(routes["repos/octo/app/pulls/2"] as object), title: "Renamed" };
  const { data, calls } = await changed(
    routes,
    [
      { kind: "pull_request", repo: "octo/app", action: "closed", pull: 1 },
      { kind: "pull_request", repo: "octo/app", action: "edited", pull: 2 },
      { kind: "pull_request", repo: "octo/app", action: "opened", pull: 8 },
      { kind: "pull_request", repo: "octo/app", action: "opened", pull: 9 },
      // Gone by the time it is read.
      { kind: "pull_request", repo: "octo/app", action: "opened", pull: 10 },
    ],
    before,
  );
  expect(data.pulls.map((one) => [one.repo, one.number])).toEqual([
    ["octo/app", 9],
    ["octo/app", 8],
    ["octo/app", 2],
    ["octo/lib", 5],
  ]);
  expect(data.pulls[2]?.title).toBe("Renamed");
  // A closed one's checks aren't asked for, and the list of open ones isn't either.
  expect(calls).toEqual(
    [
      "repos/octo/app/pulls/1",
      "repos/octo/app/pulls/10",
      ...pullCalls("octo/app", 2),
      ...pullCalls("octo/app", 8),
      ...pullCalls("octo/app", 9),
    ].sort(),
  );
});

test("a workflow's run or job reads the repository's release runs", async () => {
  const { routes, before } = await everything();
  expect(before.releases).toMatchObject([{ id: 4, state: "passed" }]);
  withWorkflow(routes, "octo/app", { id: 6, name: "CI" }, [{ id: 7 }]);
  (routes["repos/octo/app/actions/workflows/3/runs"] as { workflow_runs: unknown[] }).workflow_runs.unshift(
    run("octo/app", 5, { status: "in_progress", conclusion: null }),
  );
  routes["repos/octo/app/actions/runs/5/jobs"] = {
    total_count: 1,
    jobs: [job(51, { status: "in_progress", conclusion: null, completed_at: null })],
  };
  const { data, calls } = await changed(
    routes,
    [
      { kind: "workflow_run", repo: "octo/app", action: "in_progress", sha: "main1", run: 5 },
      { kind: "workflow_job", repo: "octo/app", action: "in_progress", sha: "main1", run: 5 },
    ],
    before,
  );
  expect(calls).toEqual([
    "repos/octo/app/actions/runs/4/jobs?per_page=100",
    "repos/octo/app/actions/runs/5/jobs?per_page=100",
    "repos/octo/app/actions/workflows/3/runs?per_page=5",
    "repos/octo/app/actions/workflows?per_page=100",
  ]);
  expect(data.releases).toMatchObject([
    { id: 5, state: "running", jobs: [{ id: 51, state: "running" }] },
    { id: 4, state: "passed" },
  ]);
  expect(data.pulls).toEqual(before.pulls);
});

test("a workflow's run on a pull request reads that pull request too", async () => {
  const { routes, before } = await everything();
  const { calls } = await changed(routes, [{ kind: "workflow_run", repo: "octo/lib", sha: "sha5" }], before);
  expect(calls).toEqual(["repos/octo/lib/actions/workflows?per_page=100", ...pullCalls("octo/lib", 5)]);
});

test("a release reads the repository's latest release", async () => {
  const { routes, before } = await everything();
  routes["repos/octo/app/releases/latest"] = {
    tag_name: "v1.1.0",
    html_url: "https://github.com/octo/app/releases/tag/v1.1.0",
    created_at: "2026-11-05T00:00:00Z",
    published_at: null,
  };
  const { data, calls } = await changed(
    routes,
    [
      { kind: "release", repo: "octo/app", action: "published" },
      { kind: "release", repo: "octo/lib", action: "deleted" },
    ],
    before,
  );
  expect(calls).toEqual(["repos/octo/app/releases/latest", "repos/octo/lib/releases/latest"]);
  expect(data.projects).toEqual([
    {
      ...before.projects[0],
      latestRelease: {
        tag: "v1.1.0",
        url: "https://github.com/octo/app/releases/tag/v1.1.0",
        publishedAt: "2026-11-05T00:00:00Z",
      },
    },
    before.projects[1],
  ]);
  expect(data.pulls).toEqual(before.pulls);
});

test("a push reads every pull request of the repository, as their base may have moved", async () => {
  const { routes, before } = await everything();
  routes["repos/octo/app/pulls/1"] = { ...(routes["repos/octo/app/pulls/1"] as object), mergeable_state: "behind" };
  withPull(routes, "octo/app", 3);
  const { data, calls } = await changed(routes, [{ kind: "push", repo: "octo/app", sha: "main2" }], before);
  expect(calls).toEqual(
    [
      "repos/octo/app/pulls?state=open&per_page=100",
      ...pullCalls("octo/app", 1),
      ...pullCalls("octo/app", 2),
      ...pullCalls("octo/app", 3),
    ].sort(),
  );
  expect(data.pulls.map((one) => [one.number, one.mergeState])).toEqual([
    [1, "behind"],
    [2, "clean"],
    [3, "clean"],
    [5, "clean"],
  ]);
});

test("a part that can't be read again stays as it was, and is a problem", async () => {
  const { routes, before } = await everything();
  routes["repos/octo/app/pulls/1"] = () => new Response(null, { status: 502 });
  routes["repos/octo/lib/releases/latest"] = () => Response.json({ message: "no" }, { status: 403 });
  routes["repos/octo/app/actions/runs/4/jobs"] = { total_count: 0, jobs: [] };
  const first = await changed(
    routes,
    [
      { kind: "workflow_run", repo: "octo/app", sha: "sha1" },
      { kind: "check_run", repo: "octo/app", sha: "sha2" },
    ],
    before,
  );
  expect(first.problem).toBe("Couldn't read everything from octo/app.");
  // Neither pull request is taken from a read that got only one of them; the release runs were read.
  expect(first.data.pulls).toEqual(before.pulls);
  expect(first.data.releases).toMatchObject([{ id: 4, jobs: [] }]);

  const second = await changed(
    routes,
    [
      { kind: "check_run", repo: "octo/app", sha: "sha1" },
      { kind: "release", repo: "octo/lib" },
    ],
    before,
  );
  expect(second.problem).toBe("Couldn't read everything from 2 projects.");
  expect(second.data).toEqual(before);
});

test.each([
  ["a rate limit", () => Response.json({}, { status: 403, headers: { "retry-after": "60" } }), 403],
  ["a sign-in GitHub no longer accepts", () => new Response(null, { status: 401 }), 401],
])("%s fails a read of changes as it does a read of everything", async (_, answer, status) => {
  const { routes, before } = await everything();
  routes["repos/octo/app/pulls/1"] = answer;
  const error = await changed(routes, [{ kind: "check_run", repo: "octo/app", sha: "sha1" }], before).catch(
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(GitHubError);
  expect(error).toMatchObject({ status });
});
