import { readFileSync } from "node:fs";
import { beforeEach, expect, test } from "vitest";
import type { Job } from "../model.ts";
import { createApi } from "./api.ts";
import { readDashboard } from "./read.ts";
import { account, fakeGitHub, job, type Routes, withWorkflow } from "./testing.ts";
import { forgetWorkflowFiles, jobGraph, KEPT_FILES, workflowFile, workflowJobs } from "./workflow_graph.ts";

const OWN_RELEASE = readFileSync(".github/workflows/release.yml", "utf8");
const COUNTDOWN_RELEASE = readFileSync("web/src/github/fixtures/countdown-server/release.yml", "utf8");
const COUNTDOWN_PROMOTE = readFileSync("web/src/github/fixtures/countdown-server/promote.yml", "utf8");

beforeEach(forgetWorkflowFiles);

let nextId = 1;
const runJob = (name: string, fields: Partial<Job> = {}): Job => ({
  id: nextId++,
  name,
  state: "passed",
  url: undefined,
  startedAt: undefined,
  finishedAt: undefined,
  ...fields,
});

const summary = (definitions: ReturnType<typeof workflowJobs>) =>
  definitions.map(({ key, label, needs, several }) => ({ key, label, needs, several }));

test("reads this repository's release workflow", () => {
  expect(summary(workflowJobs(OWN_RELEASE))).toEqual([
    { key: "tag", label: "tag", needs: [], several: false },
    { key: "build", label: "build", needs: ["tag"], several: true },
    { key: "image", label: "image", needs: ["tag", "build"], several: false },
    { key: "github-release", label: "github-release", needs: ["tag", "image"], several: false },
    { key: "deploy", label: "deploy", needs: ["tag", "image"], several: false },
  ]);
});

test("reads the old dashboard's release and promote workflows", () => {
  expect(summary(workflowJobs(COUNTDOWN_RELEASE))).toEqual([
    { key: "tag", label: "tag", needs: [], several: false },
    { key: "build", label: "build", needs: ["tag"], several: true },
    { key: "images", label: "images", needs: ["tag", "build"], several: true },
    { key: "github-release", label: "github-release", needs: ["tag"], several: false },
    { key: "deploy-dev", label: "deploy (dev)", needs: ["tag", "images"], several: true },
  ]);
  expect(summary(workflowJobs(COUNTDOWN_PROMOTE))).toEqual([
    { key: "check", label: "check", needs: [], several: false },
    { key: "approve", label: "approve production", needs: ["check"], several: false },
    { key: "deploy", label: "deploy (prod)", needs: ["check", "approve"], several: true },
  ]);
});

test.each([
  ["not YAML", "jobs: [a"],
  ["no jobs", "name: x\non: push\n"],
  ["empty jobs", "jobs: {}\n"],
  ["jobs that aren't a map", "jobs:\n  - a\n"],
  ["needs that aren't names", "jobs:\n  a:\n    needs: [{b: c}]\n"],
])("refuses a file with %s", (_, text) => {
  expect(() => workflowJobs(text)).toThrow();
});

test("places a run's jobs on the file's jobs by name", () => {
  const jobs = [
    runJob("tag"),
    runJob("build (amd64)"),
    runJob("build (arm64)"),
    runJob("image"),
    runJob("github-release", { state: "queued" }),
    runJob("something the file has lost"),
  ];
  const graph = jobGraph(workflowJobs(OWN_RELEASE), jobs);
  expect(graph.nodes.map((node) => [node.key, node.jobs.map((one) => one.name)])).toEqual([
    ["tag", ["tag"]],
    ["build", ["build (amd64)", "build (arm64)"]],
    ["image", ["image"]],
    ["github-release", ["github-release"]],
    ["deploy", []],
  ]);
  expect(graph.unplaced.map((one) => one.name)).toEqual(["something the file has lost"]);
});

test("places matrix jobs, reusable workflows' jobs and computed names", () => {
  const jobs = [
    runJob("tag"),
    runJob("build countdown-server (amd64)"),
    runJob("build countdown-server-caddy (arm64)"),
    runJob("image countdown-server"),
    runJob("image countdown-server-caddy"),
    runJob("github-release"),
    runJob("deploy (dev) / deploy (dev, docker context)"),
  ];
  const graph = jobGraph(workflowJobs(COUNTDOWN_RELEASE), jobs);
  expect(Object.fromEntries(graph.nodes.map((node) => [node.key, node.jobs.length]))).toEqual({
    tag: 1,
    build: 2,
    images: 2,
    "github-release": 1,
    "deploy-dev": 1,
  });
  expect(graph.unplaced).toEqual([]);
});

test("a name given outright wins over a pattern, then the most specific pattern", () => {
  const text = `
jobs:
  test:
    strategy:
      matrix: {os: [a, b]}
  test-e2e:
    name: test (e2e)
  deploy:
    name: deploy \${{ inputs.env }}
  deploy-prod:
    name: deploy prod \${{ inputs.region }}
    needs: [deploy, nowhere, deploy-prod]
`;
  const graph = jobGraph(workflowJobs(text), [
    runJob("test (a)"),
    runJob("test (e2e)"),
    runJob("deploy dev"),
    runJob("deploy prod eu"),
  ]);
  expect(graph.nodes.map((node) => [node.key, node.name, node.jobs.map((one) => one.name), node.needs])).toEqual([
    ["test", "test", ["test (a)"], []],
    ["test-e2e", "test (e2e)", ["test (e2e)"], []],
    // A name worked out as it runs is shown by the job's id, as GitHub's graph does.
    ["deploy", "deploy", ["deploy dev"], []],
    // Needs of no job of the file, and of itself, are left out.
    ["deploy-prod", "deploy-prod", ["deploy prod eu"], ["deploy"]],
  ]);
});

/** A fake GitHub with one workflow file at a commit, as the contents API answers it. */
function withFile(routes: Routes, repo: string, path: string, sha: string, text: string): void {
  routes[`repos/${repo}/contents/${path}?ref=${sha}`] = {
    type: "file",
    encoding: "base64",
    // GitHub wraps the base64 at 60 characters.
    content: Buffer.from(text, "utf8").toString("base64").replace(/.{60}/g, "$&\n"),
  };
}

test("reads the workflow file at the run's commit once, and keeps it", async () => {
  const routes: Routes = {};
  withFile(routes, "octo/app", ".github/workflows/release.yml", "abc", OWN_RELEASE);
  const { auth, calls } = fakeGitHub(routes);
  const api = createApi(auth);
  const first = await workflowFile(api, "octo/app", ".github/workflows/release.yml", "abc");
  expect(first?.map((one) => one.key)).toEqual(["tag", "build", "image", "github-release", "deploy"]);
  // A run's path can carry the ref it ran from.
  const again = await Promise.all([
    workflowFile(api, "octo/app", ".github/workflows/release.yml@refs/heads/main", "abc"),
    workflowFile(createApi(auth), "octo/app", ".github/workflows/release.yml", "abc"),
  ]);
  expect(again).toEqual([first, first]);
  expect(calls).toEqual(["repos/octo/app/contents/.github/workflows/release.yml?ref=abc"]);

  // Another commit is another file; signing out forgets them.
  await workflowFile(api, "octo/app", ".github/workflows/release.yml", "def");
  forgetWorkflowFiles();
  await workflowFile(api, "octo/app", ".github/workflows/release.yml", "abc");
  expect(calls).toHaveLength(3);
});

test("keeps the last files used, up to a limit", async () => {
  const { auth, calls } = fakeGitHub({});
  const api = createApi(auth);
  for (let n = 0; n <= KEPT_FILES; n++) {
    await workflowFile(api, "octo/app", "w.yml", `sha${n}`);
  }
  // The first is the oldest and has gone; the last is still kept.
  await workflowFile(api, "octo/app", "w.yml", `sha${KEPT_FILES}`);
  expect(calls).toHaveLength(KEPT_FILES + 1);
  await workflowFile(api, "octo/app", "w.yml", "sha0");
  expect(calls).toHaveLength(KEPT_FILES + 2);
});

test("has no jobs for a file that isn't there or isn't a workflow, and keeps that", async () => {
  const routes: Routes = {
    "repos/octo/app/contents/big.yml": { type: "file", encoding: "none", content: "" },
    "repos/octo/app/contents/dir": [],
  };
  withFile(routes, "octo/app", "bad.yml", "abc", "jobs: [oops");
  const { auth, calls } = fakeGitHub(routes);
  const api = createApi(auth);
  for (const path of ["missing.yml", "big.yml", "dir", "bad.yml"]) {
    expect(await workflowFile(api, "octo/app", path, "abc")).toBeUndefined();
    expect(await workflowFile(api, "octo/app", path, "abc")).toBeUndefined();
  }
  expect(calls).toHaveLength(4);
});

test("has no jobs this time when GitHub refuses the file, and asks again next time", async () => {
  const { auth, calls } = fakeGitHub({
    "repos/octo/app/contents/w.yml": () => Response.json({ message: "Server Error" }, { status: 502 }),
  });
  const api = createApi(auth);
  expect(await workflowFile(api, "octo/app", "w.yml", "abc")).toBeUndefined();
  expect(await workflowFile(api, "octo/app", "w.yml", "abc")).toBeUndefined();
  expect(calls).toHaveLength(2);
});

test("throws a rate limit or an expired sign-in, as every other read does", async () => {
  const { auth } = fakeGitHub({
    "repos/octo/app/contents/limited.yml": () => new Response("{}", { status: 429, headers: { "retry-after": "30" } }),
    "repos/octo/app/contents/expired.yml": () => new Response("{}", { status: 401 }),
  });
  const api = createApi(auth);
  await expect(workflowFile(api, "octo/app", "limited.yml", "abc")).rejects.toMatchObject({ status: 429 });
  await expect(workflowFile(api, "octo/app", "expired.yml", "abc")).rejects.toMatchObject({ status: 401 });
});

test("a release run gets its graph from the workflow file at its commit, or none", async () => {
  const routes = account("octo/app");
  withWorkflow(routes, "octo/app", { id: 3, name: "Release", path: ".github/workflows/release.yml" }, [
    {
      id: 2,
      head_sha: "abc",
      path: ".github/workflows/release.yml",
      jobs: [job(10, { name: "tag" }), job(11, { name: "build (amd64)" }), job(12, { name: "lost" })],
    },
  ]);
  withWorkflow(routes, "octo/app", { id: 4, name: "Deploy" }, [{ id: 3, head_sha: "def", jobs: [job(20)] }]);
  withFile(routes, "octo/app", ".github/workflows/release.yml", "abc", OWN_RELEASE);
  const { auth } = fakeGitHub(routes);
  const { data } = await readDashboard(createApi(auth));
  const release = data.releases.find((one) => one.id === 2);
  expect(release?.graph?.nodes.map((node) => [node.key, node.jobs.map((one) => one.id)])).toEqual([
    ["tag", [10]],
    ["build", [11]],
    ["image", []],
    ["github-release", []],
    ["deploy", []],
  ]);
  expect(release?.graph?.unplaced.map((one) => one.id)).toEqual([12]);
  // Deploy's file (.github/workflows/4.yml) isn't there: its jobs are shown without a graph.
  const deploy = data.releases.find((one) => one.id === 3);
  expect(deploy?.graph).toBeUndefined();
  expect(deploy?.jobs.map((one) => one.id)).toEqual([20]);
});
