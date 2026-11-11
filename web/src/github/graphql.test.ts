import { beforeEach, expect, test } from "vitest";
import { GitHubError } from "./api.ts";
import { PULLS_PER_REPO, queryFor, REPOS_PER_REQUEST, readEverything, split, workflowUrl } from "./graphql.ts";
import { account, fakeGitHub, job, type Routes, withPull, withWorkflow } from "./testing.ts";
import { forgetWorkflowFiles } from "./workflow_graph.ts";

beforeEach(() => {
  // Each test starts as a page that has just loaded: no workflow file is known.
  forgetWorkflowFiles();
});

/** An account with a release workflow that has run, and a pull request. */
function app(): Routes {
  const routes = account("octo/app", "octo/lib");
  withPull(routes, "octo/app", 1);
  withWorkflow(routes, "octo/app", { id: 3, name: "Release" }, [{ id: 4, jobs: [job(41)] }]);
  return routes;
}

test("a first visit asks three times: which projects, what is in them, and how their release workflows ran", async () => {
  const { auth, calls, queries } = fakeGitHub(app());
  const { data, problem, shape } = await readEverything(auth);
  expect(calls).toEqual(["graphql", "graphql", "graphql"]);
  expect(queries[0]).toContain("viewer {");
  expect(queries[0]).not.toContain("repository(");
  expect(queries[1]).toContain('r0: repository(owner: "octo", name: "app")');
  expect(queries[2]).toContain(`w0: resource(url: "${workflowUrl("octo/app", ".github/workflows/3.yml")}")`);
  expect(problem).toBeUndefined();
  expect(data.projects.map((one) => one.repo)).toEqual(["octo/app", "octo/lib"]);
  expect(data.pulls.map((one) => one.number)).toEqual([1]);
  // It has finished: a link to it is all it shows, so its jobs aren't read.
  expect(data.releases).toMatchObject([{ id: 4, workflow: "Release", state: "passed", jobs: [] }]);
  expect(queries.join("\n")).not.toContain("checkRuns");
  // Which workflows to ask about next time: only names.
  expect(shape).toEqual({ "octo/app": [".github/workflows/3.yml"], "octo/lib": [] });
});

test("with the shape of the last read everything is asked at once, also on a page that has just loaded", async () => {
  const routes = app();
  const first = await readEverything(fakeGitHub(routes).auth);

  const warm = fakeGitHub(routes);
  const again = await readEverything(warm.auth, { shape: first.shape, previous: first.data });
  // The list, the projects and the workflows, side by side.
  expect(warm.calls).toEqual(["graphql", "graphql", "graphql"]);
  expect(warm.peak()).toBe(3);
  expect(again.data).toEqual(first.data);
  // The workflow files are known by now, so their text isn't asked for again.
  expect(warm.queries.join("\n")).not.toContain("... on Blob { text }");

  forgetWorkflowFiles();
  const reloaded = fakeGitHub(routes);
  const fresh = await readEverything(reloaded.auth, { shape: first.shape });
  expect(reloaded.calls).toHaveLength(3);
  expect(reloaded.peak()).toBe(3);
  expect(reloaded.queries.join("\n")).toContain("... on Blob { text }");
  expect(fresh.data).toEqual(first.data);
  expect(fresh.shape).toEqual(first.shape);
});

test("of a hidden project only its row is read, and one that is new is read in full", async () => {
  const routes = app();
  withPull(routes, "octo/lib", 7);
  const first = fakeGitHub(routes);
  const { data, shape } = await readEverything(first.auth, { hidden: new Set(["octo/app"]) });
  expect(data.projects.map((one) => one.repo)).toEqual(["octo/app", "octo/lib"]);
  expect(data.pulls.map((one) => one.repo)).toEqual(["octo/lib"]);
  expect(data.releases).toEqual([]);
  expect(first.queries.join("\n")).not.toContain('name: "app"');
  expect(shape).toEqual({ "octo/lib": [] });

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

test("a workflow file that changed is read once more, and a new release workflow is asked about", async () => {
  const routes = app();
  const first = await readEverything(fakeGitHub(routes).auth);

  withWorkflow(routes, "octo/app", { id: 5, name: "Deploy" }, [{ id: 6 }]);
  const { auth, queries } = fakeGitHub(routes);
  const { data, shape } = await readEverything(auth, { shape: first.shape, previous: first.data });
  // The read as shaped, in three requests; then the file that wasn't known; then the workflow it turned out to be.
  expect(queries).toHaveLength(5);
  expect(queries[3]).toMatch(/b0: repository\(owner: "octo", name: "app"\) \{ object\(oid: "/);
  expect(queries[4]).toContain("actions/workflows/5.yml");
  expect(data.releases.map((one) => one.id).sort()).toEqual([4, 6]);
  expect(shape["octo/app"]).toEqual([".github/workflows/3.yml", ".github/workflows/5.yml"]);
});

test("a run's jobs are read only while it is going, by asking for that run by itself", async () => {
  const routes = account("octo/app");
  withWorkflow(routes, "octo/app", { id: 3, name: "Release" }, [
    { id: 9, status: "in_progress", conclusion: null, jobs: [job(91, { status: "in_progress", conclusion: null })] },
    { id: 8, jobs: [job(81)] },
    { id: 7, jobs: [job(71)] },
  ]);
  const { auth, queries } = fakeGitHub(routes);
  const { data, problem } = await readEverything(auth);
  expect(problem).toBeUndefined();
  // The run under way with its jobs, and the last one that finished without.
  expect(data.releases.map((one) => [one.id, one.jobs.map((each) => each.id)])).toEqual([
    [9, [91]],
    [8, []],
  ]);
  expect(queries.at(-1)).toMatch(
    /n0: node\(id: "RUN:octo\/app:3:9"\) \{ \.\.\. on WorkflowRun \{ \.\.\.Run \.\.\.Going/,
  );
  // The one that finished behind it, only as its card shows it.
  expect(queries.at(-1)).toContain('n1: node(id: "RUN:octo/app:3:8") { ... on WorkflowRun { ...Run } }');
  expect(queries.join("\n")).not.toContain("RUN:octo/app:3:7");

  // Once it has finished it is the only one shown, and nothing more is asked.
  routes["repos/octo/app/actions/workflows/3/runs"] = {
    workflow_runs: [{ id: 9 }, { id: 8 }, { id: 7 }].map((one) => ({
      ...(routes["repos/octo/app/actions/workflows/3/runs"] as { workflow_runs: { id: number }[] }).workflow_runs.find(
        (run) => run.id === one.id,
      ),
      status: "completed",
      conclusion: "success",
    })),
  };
  const later = fakeGitHub(routes);
  const after = await readEverything(later.auth);
  expect(after.data.releases.map((one) => one.id)).toEqual([9]);
  expect(later.queries.join("\n")).not.toContain("node(id:");
});

test("a read is split into requests of a few projects or workflows each", () => {
  const repos = Array.from({ length: REPOS_PER_REQUEST * 2 + 1 }, (_, index) => `octo/r${index}`);
  const flows = [{ repo: "octo/r0", path: ".github/workflows/release.yml" }];
  const parts = split({ list: { after: undefined }, repos, flows, runs: [], blobs: [], texts: true });
  expect(parts.map((part) => [part.list !== undefined, part.repos.length, part.flows.length, part.texts])).toEqual([
    [true, 0, 0, true],
    [false, REPOS_PER_REQUEST, 0, true],
    [false, REPOS_PER_REQUEST, 0, true],
    [false, 1, 0, true],
    [false, 0, 1, true],
  ]);
  expect(split({ list: undefined, repos: [], flows: [], runs: [], blobs: [], texts: false })).toEqual([]);
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
  expect(data.releases).toEqual([]);
  expect(shape).toEqual({ "octo/lib": [] });
  expect(problem).toBeUndefined();
});

/** A fake GitHub whose GraphQL answers are `change`d on their way out. */
// biome-ignore lint/suspicious/noExplicitAny: answers shaped like GitHub's, as loosely typed as its JSON.
type Json = Record<string, any>;

function altered(routes: Routes, change: (data: Json, body: Json) => void) {
  const inner = fakeGitHub(routes);
  const outer = fakeGitHub({
    ...routes,
    "POST graphql": async () => {
      const query = outer.requests.at(-1)?.body as { query: string };
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
  withWorkflow(routes, "octo/lib", { id: 3, name: "Release" }, [
    { id: 4, status: "in_progress", conclusion: null, jobs: [job(41), job(42)] },
  ]);
  const { auth, calls } = altered(routes, (data) => {
    for (const [name, field] of Object.entries(data)) {
      if (!/^[rn]\d+$/.test(name) || !field) {
        continue;
      }
      // octo/app has more open pull requests than one answer holds.
      if (field.pullRequests?.nodes.length === 2) {
        field.pullRequests.nodes.pop();
        field.pullRequests.pageInfo.hasNextPage = true;
      }
      // octo/lib's pull request has more checks, and its run more jobs.
      for (const one of field.pullRequests?.nodes ?? []) {
        if (one.number === 3) {
          one.statusCheckRollup.contexts = { pageInfo: { hasNextPage: true }, nodes: [] };
        }
      }
      if (field.checkSuite?.checkRuns) {
        field.checkSuite.checkRuns = { pageInfo: { hasNextPage: true }, nodes: [field.checkSuite.checkRuns.nodes[0]] };
      }
    }
  });
  const { data, problem } = await readEverything(auth);
  expect(problem).toBeUndefined();
  expect(data.pulls.map((one) => one.number)).toEqual([1, 2, 3]);
  expect(data.pulls[2]?.checks).toEqual([{ name: "all of them", state: "passed", url: undefined }]);
  expect(data.releases[0]?.jobs.map((one) => one.id)).toEqual([41, 42]);
  expect(calls).toContain("repos/octo/app/pulls?state=open&per_page=100");
  expect(calls).toContain("repos/octo/lib/pulls/3");
  expect(calls).toContain("repos/octo/lib/actions/runs/4/jobs?per_page=100");
  expect(calls).not.toContain("repos/octo/lib/pulls?state=open&per_page=100");
});

test("a field GitHub answers only in part is shown as far as it came, with a problem; approvals it won't show are none", async () => {
  const routes = account("octo/app");
  withPull(routes, "octo/app", 1);
  withWorkflow(routes, "octo/app", { id: 3, name: "Release" }, [
    { id: 4, status: "waiting", conclusion: null, jobs: [job(42, { status: "waiting", conclusion: null })] },
  ]);
  routes["repos/octo/app/actions/runs/4/pending_deployments"] = () => Response.json({}, { status: 403 });
  const quiet = altered(routes, (data, body) => {
    if (data.w0) {
      data.w0.runs.nodes[0].pendingDeploymentRequests = null;
      body.errors = [{ type: "FORBIDDEN", path: ["w0", "runs", "nodes", 0, "pendingDeploymentRequests"] }];
    }
  });
  const waiting = await readEverything(quiet.auth);
  expect(waiting.problem).toBeUndefined();
  expect(waiting.data.releases).toMatchObject([{ id: 4, state: "waiting", approvals: [] }]);

  forgetWorkflowFiles();
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

test("a workflow GitHub won't tell about leaves the project's releases as they were, with a problem", async () => {
  const routes = app();
  const first = await readEverything(fakeGitHub(routes).auth);
  routes["repos/octo/app/actions/workflows/3/runs"] = () => new Response(null, { status: 502 });
  withPull(routes, "octo/app", 2);
  const { data, problem, shape } = await readEverything(fakeGitHub(routes).auth, {
    shape: first.shape,
    previous: first.data,
  });
  expect(problem).toBe("Couldn't read everything from octo/app.");
  expect(data.releases).toEqual(first.data.releases);
  expect(data.pulls.map((one) => one.number)).toEqual([1, 2]);
  expect(shape).toEqual(first.shape);
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
  const nothing = { list: undefined, repos: [], flows: [], runs: [], blobs: [], texts: false };
  const list = queryFor({ ...nothing, list: { after: 'cur"sor' } });
  expect(list).toContain(String.raw`after: "cur\"sor"`);
  expect(list).toContain("fragment Listed on Repository");
  // A fragment nobody uses is an error to GitHub.
  expect(list).not.toContain("fragment Pulls");
  expect(list).not.toContain("fragment Run");

  const repos = queryFor({ ...nothing, repos: ["octo/app"] });
  expect(repos).not.toContain("viewer");
  expect(repos).toContain(`pullRequests(first: ${PULLS_PER_REPO}, states: OPEN`);
  expect(repos).toContain("entries { path type oid }");
  expect(queryFor({ ...nothing, repos: ["octo/app"], texts: true })).toContain(
    "entries { path type oid object { ... on Blob { text } } }",
  );

  const flow = queryFor({ ...nothing, flows: [{ repo: "octo/app", path: ".github/workflows/my release.yml" }] });
  expect(flow).toContain('resource(url: "https://github.com/octo/app/actions/workflows/my%20release.yml")');
  // Of a workflow only whether its runs finished, and the latest as its card shows it: no jobs.
  expect(flow).not.toContain("checkRuns");
  expect(flow).not.toContain("fragment Going");
  const going = queryFor({
    ...nothing,
    runs: [{ repo: "octo/app", path: ".github/workflows/my release.yml", id: "WFR_1", going: true }],
  });
  expect(going).toContain('file(path: ".github/workflows/my release.yml") { oid }');
  expect(going).toContain("fragment Going");
});
