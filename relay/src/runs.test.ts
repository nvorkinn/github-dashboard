import { afterEach, expect, test, vi } from "vitest";
import type { ReleaseRun } from "../../shared/runs.ts";
import { createRuns, rawRun } from "./runs.ts";
import { blob, fakeApp, settle } from "./testing.ts";
import { createDefinitions } from "./workflows.ts";

const REPO = "nvorkinn/countdown";
const PATH = ".github/workflows/release.yml";
const RELEASE = `name: Release
# dashboard: release
jobs:
  build:
    runs-on: x
  deploy:
    needs: build
    environment: production
    runs-on: x
`;
const repository = { full_name: REPO, default_branch: "main" };

function run(id: number, status: string, more: Record<string, unknown> = {}) {
  return {
    id,
    name: "Release",
    display_title: "v1.2.3",
    head_branch: "v1.2.3",
    event: "push",
    html_url: `https://github.com/${REPO}/actions/runs/${id}`,
    status,
    conclusion: status === "completed" ? "success" : null,
    actor: { login: "nvorkinn" },
    created_at: `2026-11-14T12:0${id % 10}:00Z`,
    updated_at: `2026-11-14T12:3${id % 10}:00Z`,
    head_sha: "a".repeat(40),
    path: PATH,
    run_attempt: 1,
    ...more,
  };
}

function job(id: number, name: string, status: string, more: Record<string, unknown> = {}) {
  return {
    id,
    run_id: 10,
    run_attempt: 1,
    name,
    status,
    conclusion: status === "completed" ? "success" : null,
    html_url: `https://github.com/${REPO}/actions/runs/10/job/${id}`,
    started_at: "2026-11-14T12:01:00Z",
    completed_at: status === "completed" ? "2026-11-14T12:02:00Z" : null,
    ...more,
  };
}

async function setUp(routes: Record<string, unknown> = {}) {
  const github = fakeApp([{ repo: REPO }], {
    [`repos/${REPO}/contents/.github/workflows`]: [{ type: "file", path: PATH, sha: "r1" }],
    [`repos/${REPO}/git/blobs/r1`]: blob(RELEASE),
    [`repos/${REPO}/actions/workflows`]: { workflows: [{ id: 1, path: PATH, name: "Release", state: "active" }] },
    [`repos/${REPO}/actions/workflows/1/runs?per_page=5`]: { workflow_runs: [] },
    ...routes,
  });
  const definitions = createDefinitions({ app: github.app });
  await definitions.load();
  const told: ReleaseRun[] = [];
  let lists = 0;
  const runs = createRuns({
    app: github.app,
    definitions,
    onRun: (one) => told.push(one),
    onRuns: () => {
      lists++;
    },
  });
  await runs.reconcile(REPO);
  github.calls.length = 0;
  return {
    github,
    definitions,
    runs,
    told,
    lists: () => lists,
    async send(kind: string, payload: Record<string, unknown>) {
      runs.onWebhook(kind, { repository, ...payload });
      await settle();
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

test("a run that starts is told whole, with its workflow's jobs laid out and none of GitHub read", async () => {
  const { github, runs, told, send } = await setUp();
  await send("workflow_run", { action: "requested", workflow_run: run(10, "queued") });

  expect(github.calls).toEqual([]);
  expect(told).toHaveLength(1);
  expect(told[0]).toMatchObject({
    repo: REPO,
    id: 10,
    workflow: "Release",
    title: "v1.2.3",
    tag: "v1.2.3",
    state: "queued",
    actor: "nvorkinn",
    finishedAt: undefined,
    jobs: [],
    approvals: [],
  });
  expect(told[0]?.graph?.nodes.map((node) => [node.key, node.needs, node.jobs.length])).toEqual([
    ["build", [], 0],
    ["deploy", ["build"], 0],
  ]);
  expect(runs.all()).toEqual(told);
});

test("each job's webhook updates the run, which is told whole again", async () => {
  const { github, told, send } = await setUp();
  await send("workflow_run", { action: "requested", workflow_run: run(10, "queued") });
  await send("workflow_run", { action: "in_progress", workflow_run: run(10, "in_progress") });
  await send("workflow_job", { action: "in_progress", workflow_job: job(1, "build", "in_progress") });
  await send("workflow_job", { action: "completed", workflow_job: job(1, "build", "completed") });
  await send("workflow_job", { action: "queued", workflow_job: job(2, "deploy", "queued") });

  expect(github.calls).toEqual([]);
  const last = told.at(-1);
  expect(last?.state).toBe("running");
  expect(last?.jobs.map((one) => [one.name, one.state])).toEqual([
    ["build", "passed"],
    ["deploy", "queued"],
  ]);
  expect(last?.graph?.nodes.map((node) => node.jobs.map((one) => one.id))).toEqual([[1], [2]]);
  expect(last?.graph?.unplaced).toEqual([]);
});

test("webhooks that come out of order never move a job or a run backwards", async () => {
  const { told, send } = await setUp();
  await send("workflow_run", { action: "requested", workflow_run: run(10, "queued") });
  await send("workflow_job", { action: "completed", workflow_job: job(1, "build", "completed") });
  await send("workflow_job", { action: "in_progress", workflow_job: job(1, "build", "in_progress") });
  expect(told.at(-1)?.jobs[0]?.state).toBe("passed");

  await send("workflow_run", { action: "completed", workflow_run: run(10, "completed") });
  const before = told.length;
  await send("workflow_run", { action: "in_progress", workflow_run: run(10, "in_progress") });
  await send("workflow_job", { action: "completed", workflow_job: job(2, "deploy", "completed") });
  expect(told).toHaveLength(before);
  // A finished run shows without its jobs.
  expect(told.at(-1)).toMatchObject({
    state: "passed",
    finishedAt: "2026-11-14T12:30:00Z",
    jobs: [],
    graph: undefined,
  });
});

test("runs of a workflow that is no release are left alone, and so are their jobs", async () => {
  const { github, runs, told, send } = await setUp();
  const ci = run(20, "queued", { name: "CI", path: ".github/workflows/ci.yml" });
  await send("workflow_run", { action: "requested", workflow_run: ci });
  await send("workflow_job", { action: "queued", workflow_job: job(1, "test", "queued", { run_id: 20 }) });
  expect(told).toEqual([]);
  expect(runs.all()).toEqual([]);
  expect(github.calls).toEqual([]);
});

test("a job of a run not heard of asks GitHub once what the run is", async () => {
  const { github, told, send } = await setUp({
    [`repos/${REPO}/actions/runs/10`]: run(10, "in_progress"),
    [`repos/${REPO}/actions/runs/10/jobs`]: { jobs: [job(1, "build", "completed"), job(2, "deploy", "in_progress")] },
    [`repos/${REPO}/actions/runs/20`]: run(20, "in_progress", { path: ".github/workflows/ci.yml" }),
  });
  await send("workflow_job", { action: "in_progress", workflow_job: job(2, "deploy", "in_progress") });
  expect(told.at(-1)?.jobs.map((one) => one.state)).toEqual(["passed", "running"]);

  // A CI run's jobs cost one read, the first time.
  github.calls.length = 0;
  await send("workflow_job", { action: "queued", workflow_job: job(5, "test", "queued", { run_id: 20 }) });
  await send("workflow_job", { action: "in_progress", workflow_job: job(5, "test", "in_progress", { run_id: 20 }) });
  expect(github.calls).toEqual([`repos/${REPO}/actions/runs/20`]);
  expect(told).toHaveLength(1);
});

test("a run waiting for approval says which environments, read as the app, and is told again on review", async () => {
  const pending = `repos/${REPO}/actions/runs/10/pending_deployments`;
  const { github, told, send } = await setUp({
    [pending]: [{ environment: { id: 7, name: "production" }, current_user_can_approve: false }],
  });
  await send("workflow_run", { action: "requested", workflow_run: run(10, "queued") });
  await send("workflow_job", { action: "waiting", workflow_job: job(2, "deploy", "waiting") });
  expect(told.at(-1)).toMatchObject({
    state: "waiting",
    approvals: [{ environmentId: 7, environment: "production", canApprove: false }],
  });
  // The same jobs waiting: not read again.
  await send("workflow_job", { action: "in_progress", workflow_job: job(1, "build", "in_progress") });
  expect(github.calls).toEqual([pending]);

  github.routes[pending] = [];
  await send("deployment_review", { action: "approved", workflow_run: run(10, "waiting") });
  expect(github.calls).toEqual([pending, pending]);
  // With nothing to approve, a job GitHub calls waiting is waiting for a runner.
  expect(told.at(-1)).toMatchObject({ approvals: [] });
  expect(told.at(-1)?.jobs.find((one) => one.id === 2)?.state).toBe("queued");
});

test("a job waiting whose approvals can't be read stays waiting, without them", async () => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const { told, send } = await setUp({ [`repos/${REPO}/actions/runs/10/pending_deployments`]: 403 });
  await send("workflow_run", { action: "requested", workflow_run: run(10, "queued") });
  await send("workflow_job", { action: "waiting", workflow_job: job(2, "deploy", "waiting") });
  expect(told.at(-1)).toMatchObject({ state: "waiting", approvals: [] });
});

test("a re-run starts over with the jobs GitHub lists for it", async () => {
  const { github, told, send } = await setUp({
    [`repos/${REPO}/actions/runs/10/jobs`]: {
      jobs: [job(1, "build", "completed"), job(3, "deploy", "queued", { run_attempt: 2 })],
    },
  });
  await send("workflow_run", { action: "requested", workflow_run: run(10, "queued") });
  await send("workflow_job", { action: "completed", workflow_job: job(1, "build", "completed") });
  await send("workflow_run", { action: "completed", workflow_run: run(10, "completed", { conclusion: "failure" }) });
  expect(told.at(-1)?.state).toBe("failed");

  await send("workflow_run", { action: "requested", workflow_run: run(10, "queued", { run_attempt: 2 }) });
  expect(github.calls).toEqual([`repos/${REPO}/actions/runs/10/jobs`]);
  expect(told.at(-1)).toMatchObject({ state: "queued", finishedAt: undefined });
  expect(told.at(-1)?.jobs.map((one) => [one.id, one.state])).toEqual([
    [1, "passed"],
    [3, "queued"],
  ]);
  // What still arrives of the first attempt changes nothing.
  const before = told.length;
  await send("workflow_job", { action: "completed", workflow_job: job(2, "deploy", "completed") });
  expect(told).toHaveLength(before);
});

test("a workflow's newest finished run replaces the one before, which the whole list then says", async () => {
  const { runs, lists, send } = await setUp();
  await send("workflow_run", { action: "completed", workflow_run: run(10, "completed") });
  await send("workflow_run", { action: "requested", workflow_run: run(11, "queued") });
  expect(runs.all().map((one) => one.id)).toEqual([11, 10]);
  expect(lists()).toBe(0);
  await send("workflow_run", { action: "completed", workflow_run: run(11, "completed") });
  expect(runs.all().map((one) => one.id)).toEqual([11]);
  expect(lists()).toBe(1);
});

test("at the start, each release workflow's latest runs are read: those going with their jobs", async () => {
  const { github, runs } = await setUp();
  github.routes[`repos/${REPO}/actions/workflows/1/runs?per_page=5`] = {
    workflow_runs: [run(12, "in_progress"), run(11, "completed"), run(9, "completed")],
  };
  github.routes[`repos/${REPO}/actions/runs/12/jobs`] = { jobs: [job(1, "build", "in_progress")] };
  // As after a restart: nothing is known of this repository yet.
  const definitions = createDefinitions({ app: github.app });
  await definitions.load();
  const started = createRuns({ app: github.app, definitions, onRun() {}, onRuns() {} });
  await started.reconcile(REPO);
  expect(started.all().map((one) => [one.id, one.state, one.jobs.length])).toEqual([
    [12, "running", 1],
    [11, "passed", 0],
  ]);
  expect(runs.all()).toEqual([]);

  // Looked at again with the same release workflows, nothing is read.
  github.calls.length = 0;
  await started.reconcile(REPO);
  expect(github.calls).toEqual([]);
});

test("a run keeps the workflow it started with, and goes when its workflow is no release any more", async () => {
  const { github, definitions, runs, told, send } = await setUp();
  await send("workflow_run", { action: "requested", workflow_run: run(10, "queued") });

  github.routes[`repos/${REPO}/contents/.github/workflows`] = [{ type: "file", path: PATH, sha: "r2" }];
  github.routes[`repos/${REPO}/git/blobs/r2`] = blob(RELEASE.replace("  deploy:", "  ship:"));
  definitions.onWebhook("push", { ref: "refs/heads/main", repository, installation: { id: 1 } });
  await settle();
  await runs.reconcile(REPO);
  await send("workflow_job", { action: "queued", workflow_job: job(1, "build", "queued") });
  expect(told.at(-1)?.graph?.nodes.map((node) => node.key)).toEqual(["build", "deploy"]);
  // The next run has the new one.
  await send("workflow_run", { action: "requested", workflow_run: run(11, "queued") });
  expect(told.at(-1)?.graph?.nodes.map((node) => node.key)).toEqual(["build", "ship"]);

  github.routes[`repos/${REPO}/git/blobs/r3`] = blob("name: Tests\njobs:\n  build:\n    runs-on: x\n");
  github.routes[`repos/${REPO}/contents/.github/workflows`] = [{ type: "file", path: PATH, sha: "r3" }];
  definitions.onWebhook("push", { ref: "refs/heads/main", repository, installation: { id: 1 } });
  await settle();
  await runs.reconcile(REPO);
  expect(runs.all()).toEqual([]);
});

test("the runs still going are read again, which heals a webhook that never came", async () => {
  const { github, runs, lists, send } = await setUp();
  await send("workflow_run", { action: "requested", workflow_run: run(10, "queued") });
  await send("workflow_run", { action: "completed", workflow_run: run(9, "completed") });
  github.routes[`repos/${REPO}/actions/runs/10`] = run(10, "completed", { conclusion: "failure" });
  github.calls.length = 0;
  await runs.recheck();
  expect(github.calls).toEqual([`repos/${REPO}/actions/runs/10`]);
  // It finished after run 9, which it replaces: the whole list is told.
  expect(runs.all().map((one) => [one.id, one.state])).toEqual([[10, "failed"]]);
  expect(lists()).toBe(1);
  // A run GitHub no longer has is gone.
  await send("workflow_run", { action: "requested", workflow_run: run(13, "queued") });
  await runs.recheck();
  expect(runs.all().map((one) => one.id)).toEqual([10]);
});

test("a run in a webhook is read defensively", () => {
  expect(rawRun(undefined)).toBeUndefined();
  expect(rawRun({ id: 1, html_url: "https://evil.example/run", created_at: "2026-11-14T12:00:00Z" })).toBeUndefined();
  expect(rawRun({ id: "1", html_url: "https://github.com/o/r", created_at: "2026-11-14T12:00:00Z" })).toBeUndefined();
  expect(
    rawRun({
      id: 1,
      html_url: "https://github.com/o/r/actions/runs/1",
      created_at: "2026-11-14T12:00:00Z",
      display_title: "x".repeat(1000),
      actor: "not an object",
      conclusion: 7,
    }),
  ).toEqual({
    id: 1,
    name: null,
    display_title: "x".repeat(300),
    html_url: "https://github.com/o/r/actions/runs/1",
    status: null,
    conclusion: null,
    actor: null,
    triggering_actor: null,
    created_at: "2026-11-14T12:00:00Z",
    updated_at: "2026-11-14T12:00:00Z",
    run_attempt: 1,
  });
});
