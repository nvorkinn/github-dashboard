import { expect, test } from "vitest";
import { project, run } from "../components/testing.ts";
import type { Unreleased } from "../model.ts";
import { GitHubError } from "./api.ts";
import { PULLS_PER_REPO, queryFor, REPOS_PER_REQUEST, readEverything, split } from "./graphql.ts";
import { account, fakeGitHub, type Routes, withPull } from "./testing.ts";
import { type GqlComparison, unreleasedFrom } from "./unreleased.ts";

/** An account with two projects, one with a pull request. */
function app(): Routes {
  const routes = account("octo/app", "octo/lib");
  withPull(routes, "octo/app", 1);
  return routes;
}

test("a first visit asks twice: which projects, and what is in them", async () => {
  const { auth, calls, queries } = fakeGitHub(app());
  const { data, problem, shape } = await readEverything(auth);
  expect(calls).toEqual(["graphql", "graphql"]);
  expect(queries[0]).toContain("viewer {");
  expect(queries[0]).not.toContain("repository(");
  expect(queries[1]).toContain('r0: repository(owner: "octo", name: "app")');
  expect(problem).toBeUndefined();
  expect(data.projects.map((one) => one.repo)).toEqual(["octo/app", "octo/lib"]);
  expect(data.pulls.map((one) => one.number)).toEqual([1]);
  // Which projects to ask about next time: only names.
  expect(shape).toEqual(["octo/app", "octo/lib"]);
});

test("nothing of workflows or their runs is asked: the relay tells of those, and they stay as they were", async () => {
  const { auth, calls, queries } = fakeGitHub(app());
  const previous = {
    projects: [project({ repo: "octo/app", promoteWorkflow: 9 }), project({ repo: "octo/lib" })],
    pulls: [],
    releases: [run({ repo: "octo/app", id: 4 })],
  };
  const { data } = await readEverything(auth, { previous });
  expect(data.releases).toEqual(previous.releases);
  expect(data.projects.map((one) => one.promoteWorkflow)).toEqual([9, undefined]);
  expect(queries.join("\n")).not.toMatch(/workflow|checkSuite|Blob|object\(/i);
  expect(calls.every((path) => path === "graphql")).toBe(true);
});

test("with the shape of the last read everything is asked at once", async () => {
  const routes = app();
  const first = await readEverything(fakeGitHub(routes).auth);

  const warm = fakeGitHub(routes);
  const again = await readEverything(warm.auth, { shape: first.shape, previous: first.data });
  // The list and the projects, side by side.
  expect(warm.calls).toEqual(["graphql", "graphql"]);
  expect(warm.peak()).toBe(2);
  expect(again.data).toEqual(first.data);
  expect(again.shape).toEqual(first.shape);
});

test("of a hidden project only its row and bare pull requests are read, and one that is new is read in full", async () => {
  const routes = app();
  withPull(routes, "octo/lib", 7);
  const first = fakeGitHub(routes);
  const { data, shape } = await readEverything(first.auth, { hidden: new Set(["octo/app"]) });
  expect(data.projects.map((one) => one.repo)).toEqual(["octo/app", "octo/lib"]);
  expect(data.pulls.map((one) => one.repo)).toEqual(["octo/lib"]);
  expect(first.queries.join("\n")).not.toContain('name: "app") { ...Pulls');

  // A project that wasn't there last time shows on the next read, which asks once more for what is in it.
  Object.assign(routes, { ...account("octo/app", "octo/lib", "octo/new"), ...routes });
  routes["user/installations/7/repositories"] = account("octo/app", "octo/lib", "octo/new")[
    "user/installations/7/repositories"
  ];
  withPull(routes, "octo/new", 9);
  const second = fakeGitHub(routes);
  const later = await readEverything(second.auth, { hidden: new Set(["octo/app"]), shape, previous: data });
  expect(second.calls).toEqual(["graphql", "graphql", "graphql"]);
  expect(second.queries[2]).toContain('name: "new"');
  expect(later.data.projects.map((one) => one.repo).sort()).toEqual(["octo/app", "octo/lib", "octo/new"]);
  expect(later.data.pulls.map((one) => one.number).sort()).toEqual([7, 9]);
});

test("a hidden project's bare pull requests come with the list, and stay as they were when GitHub won't say", async () => {
  const routes = app();
  withPull(routes, "octo/lib", 7);
  const first = fakeGitHub(routes);
  const { data, shape } = await readEverything(first.auth, { hidden: new Set(["octo/app", "octo/gone"]) });
  // With the list, in its one request; no more requests than without.
  expect(first.calls).toEqual(["graphql", "graphql"]);
  expect(first.queries[0]).toContain('h0: repository(owner: "octo", name: "app") { pullRequests(');
  expect(first.queries[0]).toContain("nodes { number title url }");
  const app_ = data.projects.find((one) => one.repo === "octo/app");
  expect(app_?.barePulls).toEqual([{ number: 1, title: expect.any(String), url: expect.stringContaining("/pull/1") }]);
  expect(data.projects.find((one) => one.repo === "octo/lib")?.barePulls).toBeUndefined();
  expect(data.pulls.map((one) => one.repo)).toEqual(["octo/lib"]);

  // A hidden project the last read didn't list isn't asked about again.
  const warm = fakeGitHub(routes);
  await readEverything(warm.auth, { hidden: new Set(["octo/app", "octo/gone"]), shape, previous: data });
  expect(warm.queries.join("\n")).not.toContain('name: "gone"');

  // GitHub refusing them leaves them as they were.
  routes["repos/octo/app/pulls"] = async () => new Response("", { status: 502 });
  const failing = await readEverything(fakeGitHub(routes).auth, {
    hidden: new Set(["octo/app"]),
    shape,
    previous: data,
  });
  expect(failing.data.projects.find((one) => one.repo === "octo/app")?.barePulls).toEqual(app_?.barePulls);
});

test("a read is split into requests of a few projects each", () => {
  const repos = Array.from({ length: REPOS_PER_REQUEST * 2 + 1 }, (_, index) => `octo/r${index}`);
  const compares = [{ repo: "octo/r0", tag: "v1.0.0", branch: "main" }];
  const parts = split({ list: { after: undefined }, repos, compares });
  expect(parts.map((part) => [part.list !== undefined, part.repos.length, part.compares.length])).toEqual([
    [true, 0, 0],
    [false, REPOS_PER_REQUEST, 0],
    [false, REPOS_PER_REQUEST, 0],
    [false, 1, 0],
    [false, 0, 1],
  ]);
  // A hidden project's bare pull requests go with the list.
  expect(split({ list: { after: undefined }, repos, compares: [], bare: ["octo/h"] })[0]?.bare).toEqual(["octo/h"]);
  expect(split({ list: { after: undefined }, repos, compares: [] }).some((part) => part.bare)).toBe(false);
  expect(split({ list: undefined, repos: [], compares: [] })).toEqual([]);
});

test("a project that is gone is asked about once more and then forgotten", async () => {
  const routes = app();
  const first = await readEverything(fakeGitHub(routes).auth);
  routes["user/installations/7/repositories"] = account("octo/lib")["user/installations/7/repositories"];
  const { data, shape, problem } = await readEverything(fakeGitHub(routes).auth, {
    shape: first.shape,
    previous: first.data,
  });
  expect(data.projects.map((one) => one.repo)).toEqual(["octo/lib"]);
  expect(data.pulls).toEqual([]);
  expect(shape).toEqual(["octo/lib"]);
  expect(problem).toBeUndefined();
});

/** A fake GitHub whose GraphQL answers are `change`d on their way out. */
// biome-ignore lint/suspicious/noExplicitAny: answers shaped like GitHub's, as loosely typed as its JSON.
type Json = Record<string, any>;

function altered(routes: Routes, change: (data: Json, body: Json) => void) {
  const inner = fakeGitHub(routes);
  const outer = fakeGitHub({
    ...routes,
    "POST graphql": async (_path: string, query: unknown) => {
      const response = await inner.auth.github("graphql", { method: "POST", body: JSON.stringify(query) });
      const body = await response.json();
      change(body.data, body);
      return Response.json(body, { headers: response.headers });
    },
  });
  return outer;
}

test("an app's name gets its [bot] back, and a status nobody has reported yet counts as running", async () => {
  const routes = account("octo/app");
  withPull(routes, "octo/app", 1, { pull: { user: { login: "dependabot[bot]" } } });
  let author: unknown;
  const { auth } = altered(routes, (data) => {
    const one = data.r0?.pullRequests.nodes[0];
    if (one) {
      author = { ...one.author };
      one.statusCheckRollup.contexts.nodes = [
        { __typename: "CheckRun", databaseId: 1, name: "older", status: "COMPLETED", conclusion: "TIMED_OUT" },
        { __typename: "CheckRun", databaseId: 2, name: "newer", status: "IN_PROGRESS", conclusion: null },
        { __typename: "StatusContext", context: "required", state: "EXPECTED", targetUrl: null },
      ];
    }
  });
  const { data } = await readEverything(auth);
  // GraphQL's own name for it, which the REST API and github.com write with [bot].
  expect(author).toMatchObject({ __typename: "Bot", login: "dependabot" });
  expect(data.pulls[0]?.author).toBe("dependabot[bot]");
  // The check runs newest first, as the REST API lists them.
  expect(data.pulls[0]?.checks).toEqual([
    { name: "newer", state: "running", url: undefined },
    { name: "older", state: "failed", url: undefined },
    { name: "required", state: "running", url: undefined },
  ]);
});

test("what doesn't fit into the answer is read through the REST API", async () => {
  const routes = account("octo/app", "octo/lib");
  withPull(routes, "octo/app", 1);
  withPull(routes, "octo/app", 2);
  withPull(routes, "octo/lib", 3, { checkRuns: [{ name: "all of them", status: "completed", conclusion: "success" }] });
  const { auth, calls } = altered(routes, (data) => {
    for (const [name, field] of Object.entries(data)) {
      if (!/^r\d+$/.test(name) || !field) {
        continue;
      }
      // octo/app has more open pull requests than one answer holds.
      if (field.pullRequests?.nodes.length === 2) {
        field.pullRequests.nodes.pop();
        field.pullRequests.pageInfo.hasNextPage = true;
      }
      // octo/lib's pull request has more checks.
      for (const one of field.pullRequests?.nodes ?? []) {
        if (one.number === 3) {
          one.statusCheckRollup.contexts = { pageInfo: { hasNextPage: true }, nodes: [] };
        }
      }
    }
  });
  const { data, problem } = await readEverything(auth);
  expect(problem).toBeUndefined();
  expect(data.pulls.map((one) => one.number)).toEqual([1, 2, 3]);
  expect(data.pulls[2]?.checks).toEqual([{ name: "all of them", state: "passed", url: undefined }]);
  expect(calls).toContain("repos/octo/app/pulls?state=open&per_page=100");
  expect(calls).toContain("repos/octo/lib/pulls/3");
  expect(calls).not.toContain("repos/octo/lib/pulls?state=open&per_page=100");
});

test("a field GitHub answers only in part is shown as far as it came, with a problem", async () => {
  const routes = account("octo/app");
  withPull(routes, "octo/app", 1);
  const partial = altered(routes, (data, body) => {
    if (data.r0) {
      data.r0.pullRequests.nodes[0].statusCheckRollup = null;
      body.errors = [{ type: "SERVICE_UNAVAILABLE", path: ["r0", "pullRequests", "nodes", 0, "statusCheckRollup"] }];
    }
  });
  const { data, problem } = await readEverything(partial.auth);
  expect(problem).toBe("Couldn't read everything from octo/app.");
  expect(data.pulls).toMatchObject([{ number: 1, checks: [] }]);
});

test.each([
  ["GraphQL's rate limit", { data: null, errors: [{ type: "RATE_LIMITED", message: "API rate limit exceeded" }] }, 403],
  ["an answer without data", { errors: [{ message: "Something went wrong" }] }, 502],
  ["an error that is no field's", { data: { viewer: null }, errors: [{ message: "timeout" }] }, 502],
])("%s fails the whole read", async (_, body, status) => {
  const reset = Math.floor(Date.now() / 1000) + 600;
  const { auth } = fakeGitHub({
    "POST graphql": () => Response.json(body, { headers: { "x-ratelimit-reset": String(reset) } }),
  });
  const error = await readEverything(auth).catch((thrown: unknown) => thrown);
  expect(error).toBeInstanceOf(GitHubError);
  expect(error).toMatchObject({ status, retryAt: status === 403 ? reset * 1000 : undefined });
});

test("the query asks only for what it is asked, and writes names as GraphQL strings", () => {
  const nothing = { list: undefined, repos: [], compares: [] };
  const list = queryFor({ ...nothing, list: { after: 'cur"sor' } });
  expect(list).toContain(String.raw`after: "cur\"sor"`);
  expect(list).toContain("fragment Listed on Repository");
  // A fragment nobody uses is an error to GitHub.
  expect(list).not.toContain("fragment Pulls");

  const repos = queryFor({ ...nothing, repos: ["octo/app"] });
  expect(repos).not.toContain("viewer");
  expect(repos).not.toContain("fragment Listed");
  expect(repos).toContain('r0: repository(owner: "octo", name: "app") { ...Pulls }');
  expect(repos).toContain(`pullRequests(first: ${PULLS_PER_REPO}, states: OPEN`);

  const compare = queryFor({ ...nothing, compares: [{ repo: "octo/app", tag: "v1.0.0", branch: "main" }] });
  expect(compare).toContain('c0: repository(owner: "octo", name: "app")');
  expect(compare).not.toContain("fragment");
});

const RELEASE = {
  tag_name: "v1.0.0",
  html_url: "https://github.com/octo/app/releases/tag/v1.0.0",
  created_at: "2026-11-01T00:00:00Z",
  published_at: "2026-11-01T10:00:00Z",
};

test("what is unreleased is read from the comparison of the latest release with the default branch", async () => {
  const routes = app();
  routes["repos/octo/app/releases/latest"] = RELEASE;
  // Two pull requests, one of two commits and a merge commit, and a commit pushed without one.
  routes["repos/octo/app/compare/v1.0.0...main"] = { ahead_by: 5, merged: [7, 7, 7, 8] };
  const { auth, calls, queries } = fakeGitHub(routes);
  const first = await readEverything(auth);
  expect(calls.every((path) => path === "graphql")).toBe(true);
  expect(queries[0]).toContain("defaultBranchRef { name }");
  expect(queries.join("\n")).toContain('ref(qualifiedName: "refs/tags/v1.0.0") { compare(headRef: "main")');
  expect(first.data.projects.map((one) => [one.repo, one.defaultBranch, one.unreleased])).toEqual([
    ["octo/app", "main", { commits: 5, pulls: 2 }],
    // No release: nothing to compare with.
    ["octo/lib", "main", undefined],
  ]);

  // The next read asks by the tag it knows, with everything else.
  const again = fakeGitHub(routes);
  const second = await readEverything(again.auth, { previous: first.data, shape: first.shape });
  expect(again.queries.filter((query) => query.includes("compare(")).length).toBe(1);
  expect(second.data.projects[0]?.unreleased).toEqual({ commits: 5, pulls: 2 });

  // A new release is compared once the list of projects tells of it.
  routes["repos/octo/app/releases/latest"] = { ...RELEASE, tag_name: "v1.1.0" };
  routes["repos/octo/app/compare/v1.1.0...main"] = { ahead_by: 0 };
  const third = await readEverything(fakeGitHub(routes).auth, { previous: second.data, shape: second.shape });
  expect(third.data.projects[0]?.unreleased).toEqual({ commits: 0, pulls: 0 });
});

test("what is unreleased isn't known of a release whose tag is gone, and stays as it was when it can't be read", async () => {
  const routes = app();
  routes["repos/octo/app/releases/latest"] = RELEASE;
  const gone = await readEverything(fakeGitHub(routes).auth);
  expect(gone.data.projects[0]?.unreleased).toBeUndefined();
  expect(gone.problem).toBeUndefined();

  routes["repos/octo/app/compare/v1.0.0...main"] = { ahead_by: 1, merged: [7] };
  const read = await readEverything(fakeGitHub(routes).auth);
  routes["repos/octo/app/compare/v1.0.0...main"] = () => Response.json({}, { status: 500 });
  const refused = await readEverything(fakeGitHub(routes).auth, { previous: read.data, shape: read.shape });
  expect(refused.data.projects[0]?.unreleased).toEqual({ commits: 1, pulls: 1 });
  expect(refused.problem).toBe("Couldn't read everything from octo/app.");
});

test.each<[string, GqlComparison, Unreleased | undefined]>([
  ["commits of merged pull requests, each counted once", compared(3, [[7], [7], [8]]), { commits: 3, pulls: 2 }],
  ["a commit without a pull request", compared(2, [[7], []]), { commits: 2, pulls: 1 }],
  [
    "pull requests that aren't merged into the branch",
    {
      ref: {
        compare: {
          aheadBy: 1,
          commits: {
            nodes: [
              {
                associatedPullRequests: {
                  nodes: [
                    { number: 7, merged: true, baseRefName: "main" },
                    { number: 6, merged: true, baseRefName: "feature" },
                    { number: 9, merged: false, baseRefName: "main" },
                  ],
                },
              },
            ],
          },
        },
      },
    },
    { commits: 1, pulls: 1 },
  ],
  ["nothing since", compared(0, []), { commits: 0, pulls: 0 }],
  ["more commits than were read", compared(250, [[7]]), { commits: 250, pulls: undefined }],
  ["a tag that is gone", { ref: null }, undefined],
  ["no answer", null, undefined],
])("unreleased, %s", (_, answer, expected) => {
  expect(unreleasedFrom(answer, "main")).toEqual(expected);
});

/** A comparison `ahead` commits ahead, with the numbers of each read commit's pull requests. */
function compared(ahead: number, commits: number[][]): GqlComparison {
  return {
    ref: {
      compare: {
        aheadBy: ahead,
        commits: {
          nodes: commits.map((numbers) => ({
            associatedPullRequests: {
              nodes: numbers.map((number) => ({ number, merged: true, baseRefName: "main" })),
            },
          })),
        },
      },
    },
  };
}
