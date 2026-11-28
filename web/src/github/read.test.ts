import { expect, test } from "vitest";
import { mergeState } from "../../../shared/pulls.ts";
import { project, pull } from "../components/testing.ts";
import type { DashboardData } from "../model.ts";
import { createApi, GitHubError } from "./api.ts";
import type { Change } from "./events.ts";
import { readEverything } from "./graphql.ts";
import { checks, mergeMethod, type Plan, planFor, pullFrom, readChanged } from "./read.ts";
import { account, answerQuery, fakeGitHub, type Routes, repo, withPull } from "./testing.ts";

function read(routes: Record<string, unknown>, previous?: DashboardData) {
  const github = fakeGitHub(routes);
  return { ...github, result: readEverything(github.auth, { previous }) };
}

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

test("projects are the installations' repositories, without archived ones, the last pushed first", async () => {
  const routes = {
    "user/installations": { total_count: 2, installations: [{ id: 7 }, { id: 8 }] },
    "user/installations/7/repositories": {
      total_count: 2,
      repositories: [
        repo("octo/old", { pushed_at: "2026-01-01T00:00:00Z" }),
        repo("octo/archived", { archived: true }),
      ],
    },
    "user/installations/8/repositories": {
      total_count: 2,
      repositories: [
        repo("acme/new", { pushed_at: "2026-11-10T00:00:00Z", private: true }),
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
    "repos/acme/new/compare/v2.1.0...main": { ahead_by: 4, merged: [3, 3, 5] },
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
      url: "https://github.com/acme/new",
      private: true,
      pushedAt: "2026-11-10T00:00:00Z",
      latestRelease: {
        tag: "v2.1.0",
        url: "https://github.com/acme/new/releases/tag/v2.1.0",
        publishedAt: "2026-11-09T10:00:00Z",
      },
      defaultBranch: "main",
      // On main since v2.1.0.
      unreleased: { commits: 4, pulls: 2 },
      mergeMethod: "squash",
      autoMergeAllowed: false,
    },
    {
      repo: "octo/old",
      name: "old",
      url: "https://github.com/octo/old",
      private: false,
      pushedAt: "2026-01-01T00:00:00Z",
      // A 404 from releases/latest.
      latestRelease: undefined,
      defaultBranch: "main",
      unreleased: undefined,
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

test("a pull request is read with its merge state and checks", async () => {
  const routes = account("octo/app");
  withPull(routes, "octo/app", 12, {
    pull: { mergeable_state: "blocked", auto_merge: { merge_method: "squash" }, draft: true, commits: 3 },
    checkRuns: [{ name: "test", status: "in_progress", conclusion: null, html_url: "https://github.com/r/1" }],
    statuses: [{ context: "ci/build", state: "success", target_url: null }],
  });
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
      commits: 3,
    },
  ]);
  // All of it through GraphQL: nothing is read pull request by pull request.
  expect(new Set(calls)).toEqual(new Set(["graphql"]));
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

test("a project that can't be read keeps what was read before, and the others are read", async () => {
  const routes = account("octo/app", "octo/broken", "octo/worse");
  withPull(routes, "octo/app", 1);
  withPull(routes, "octo/broken", 2);
  const before = (await read(routes).result).data;
  expect(before.pulls.map((pull) => pull.repo)).toEqual(["octo/app", "octo/broken"]);

  routes["repos/octo/broken/pulls"] = () => new Response(null, { status: 502 });
  withPull(routes, "octo/app", 3);

  const first = await read(routes).result;
  expect(first.problem).toBe("Couldn't read everything from octo/broken.");
  expect(first.data.projects).toHaveLength(3);
  expect(first.data.pulls.map((pull) => pull.number)).toEqual([1, 3]);

  const later = await read(routes, before).result;
  expect(later.data.pulls.map((pull) => pull.number)).toEqual([1, 3, 2]);

  routes["repos/octo/worse/pulls"] = () => new Response(null, { status: 500 });
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
function plan(repos: Record<string, { pulls?: "all" | number[]; latestRelease?: true; release?: true }>): Plan {
  return new Map(
    Object.entries(repos).map(([name, wanted]) => [
      name,
      {
        pulls: wanted.pulls === "all" ? "all" : new Set(wanted.pulls ?? []),
        latestRelease: wanted.latestRelease ?? false,
        ...(wanted.release ? { release: true } : {}),
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
    "a workflow's job on the default branch, which the relay tells of if it is a release",
    [{ kind: "workflow_job", repo: "octo/app", sha: "main1", run: 9 }],
    plan({}),
  ],
  [
    "a workflow run on a pull request",
    [{ kind: "workflow_run", repo: "octo/lib", sha: "sha1", run: 9 }],
    plan({ "octo/lib": { pulls: [5] } }),
  ],
  ["an approval of a deployment", [{ kind: "deployment_review", repo: "octo/app", run: 9 }], plan({})],
  [
    "a push",
    [{ kind: "push", repo: "octo/app", sha: "main2" }],
    plan({ "octo/app": { pulls: "all", latestRelease: true } }),
  ],
  ["a release", [{ kind: "release", repo: "octo/lib" }], plan({ "octo/lib": { latestRelease: true, release: true } })],
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
    plan({ "octo/app": { pulls: [1, 2], latestRelease: true, release: true }, "octo/lib": { pulls: [5] } }),
  ],
  [
    "a push among checks",
    [
      { kind: "check_run", repo: "octo/app", sha: "sha1" },
      { kind: "push", repo: "octo/app" },
      { kind: "check_run", repo: "octo/app", pull: 2 },
    ],
    plan({ "octo/app": { pulls: "all", latestRelease: true } }),
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
  const wanted = planFor(changes, before, new Set());
  if (wanted === "everything") {
    throw new Error("These changes read everything");
  }
  const github = fakeGitHub(routes);
  const result = await readChanged(createApi(github.auth), wanted, before);
  return { ...result, calls: github.calls.sort() };
}

const pullCalls = (repo: string, number: number) => [`graphql ${repo}#${number}`];

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

test("a pull request with more checks than one query's answer holds is read through the REST API", async () => {
  const { routes, before } = await everything();
  routes["repos/octo/app/commits/sha2/check-runs"] = {
    total_count: 1,
    check_runs: [{ name: "all of them", status: "completed", conclusion: "success", html_url: null }],
  };
  routes["POST graphql"] = async (_path: string, body: { query: string }) => {
    const answer = await (await answerQuery(routes, body.query)).json();
    answer.data.p.pullRequest.statusCheckRollup.contexts = { pageInfo: { hasNextPage: true }, nodes: [] };
    return Response.json(answer);
  };
  const { data, calls } = await changed(routes, [{ kind: "check_run", repo: "octo/app", sha: "sha2" }], before);
  expect(data.pulls[1]?.checks).toEqual([{ name: "all of them", state: "passed", url: undefined }]);
  expect(calls).toEqual(
    [
      ...pullCalls("octo/app", 2),
      "repos/octo/app/commits/sha2/check-runs?filter=latest&per_page=100",
      "repos/octo/app/commits/sha2/statuses?per_page=100",
      "repos/octo/app/pulls/2",
    ].sort(),
  );
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
  // One query each, and the list of open ones isn't asked for.
  expect(calls).toEqual(
    [
      ...pullCalls("octo/app", 1),
      ...pullCalls("octo/app", 10),
      ...pullCalls("octo/app", 2),
      ...pullCalls("octo/app", 8),
      ...pullCalls("octo/app", 9),
    ].sort(),
  );
});

test("a workflow's run on a pull request reads that pull request too", async () => {
  const { routes, before } = await everything();
  const { calls } = await changed(routes, [{ kind: "workflow_run", repo: "octo/lib", sha: "sha5" }], before);
  expect(calls).toEqual(pullCalls("octo/lib", 5));
});

test("a release reads the repository's latest release", async () => {
  const { routes, before } = await everything();
  routes["repos/octo/app/releases/latest"] = {
    tag_name: "v1.1.0",
    html_url: "https://github.com/octo/app/releases/tag/v1.1.0",
    created_at: "2026-11-05T00:00:00Z",
    published_at: null,
  };
  routes["repos/octo/app/compare/v1.1.0...main"] = { ahead_by: 0 };
  const { data, calls } = await changed(
    routes,
    [
      { kind: "release", repo: "octo/app", action: "published" },
      { kind: "release", repo: "octo/lib", action: "deleted" },
    ],
    before,
  );
  expect(calls).toEqual(["graphql", "repos/octo/app/releases/latest", "repos/octo/lib/releases/latest"]);
  expect(data.projects).toEqual([
    {
      ...before.projects[0],
      latestRelease: {
        tag: "v1.1.0",
        url: "https://github.com/octo/app/releases/tag/v1.1.0",
        publishedAt: "2026-11-05T00:00:00Z",
      },
      // Nothing on main since the release.
      unreleased: { commits: 0, pulls: 0 },
    },
    before.projects[1],
  ]);
  expect(data.pulls).toEqual(before.pulls);
});

test("a push reads every pull request of the repository, as their base may have moved, and what is unreleased", async () => {
  const { routes, before } = await everything();
  routes["repos/octo/app/pulls/1"] = { ...(routes["repos/octo/app/pulls/1"] as object), mergeable_state: "behind" };
  routes["repos/octo/app/compare/v1.0.0...main"] = { ahead_by: 2, merged: [4, 4] };
  withPull(routes, "octo/app", 3);
  const { data, calls } = await changed(routes, [{ kind: "push", repo: "octo/app", sha: "main2" }], before);
  expect(before.projects[0]?.unreleased).toBeUndefined();
  expect(data.projects[0]?.unreleased).toEqual({ commits: 2, pulls: 1 });
  expect(calls).toEqual(
    [
      // The release shown is compared with the moved branch again, without asking which release is the latest.
      "graphql",
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
  const first = await changed(
    routes,
    [
      { kind: "workflow_run", repo: "octo/app", sha: "sha1" },
      { kind: "check_run", repo: "octo/app", sha: "sha2" },
    ],
    before,
  );
  expect(first.problem).toBe("Couldn't read everything from octo/app.");
  // Neither pull request is taken from a read that got only one of them.
  expect(first.data.pulls).toEqual(before.pulls);

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

test("with the relay telling merge states, a push reads only the latest release, and no pull request", async () => {
  const { before } = await everything();
  expect(
    planFor([{ kind: "push", repo: "octo/app", sha: "main1" }], before, new Set(), { mergeStatesFromRelay: true }),
  ).toEqual(new Map([["octo/app", { pulls: new Set(), latestRelease: true }]]));
});

test("a pull request in a GitHub stack keeps its place in it; one outside a stack has none", () => {
  const gql = {
    id: "PR_1",
    number: 343,
    title: "Show each bed's calibration",
    url: "https://github.com/octo/app/pull/343",
    isDraft: false,
    headRefName: "calibration-screen",
    baseRefName: "calibration-store",
    headRefOid: "abc",
    createdAt: "2026-11-01T00:00:00Z",
    updatedAt: "2026-11-01T00:00:00Z",
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    autoMergeRequest: null,
    commits: { totalCount: 1 },
    author: { __typename: "User", login: "octocat" },
    statusCheckRollup: null,
  };
  const stacked = pullFrom("octo/app", { ...gql, stackEntry: { position: 3, stack: { number: 7, size: 3 } } });
  expect(stacked.stack).toEqual({ number: 7, size: 3, position: 3 });
  expect(pullFrom("octo/app", { ...gql, stackEntry: null }).stack).toBeUndefined();
});
