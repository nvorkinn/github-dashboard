import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import type { Job } from "./runs.ts";
import { isReleaseName, jobGraph, readWorkflowBlob, releasePaths, workflowJobs } from "./workflows.ts";

const OWN_RELEASE = readFileSync(".github/workflows/release.yml", "utf8");
const COUNTDOWN_RELEASE = readFileSync("web/src/github/fixtures/countdown-server/release.yml", "utf8");
const COUNTDOWN_PROMOTE = readFileSync("web/src/github/fixtures/countdown-server/promote.yml", "utf8");

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
    { key: "image", label: "image", needs: ["tag"], several: false },
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
    runJob("image"),
    runJob("github-release", { state: "queued" }),
    runJob("something the file has lost"),
  ];
  const graph = jobGraph(workflowJobs(OWN_RELEASE), jobs);
  expect(graph.nodes.map((node) => [node.key, node.jobs.map((one) => one.name)])).toEqual([
    ["tag", ["tag"]],
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

test("a workflow file says its name, its jobs and whether it is marked as a release", () => {
  expect(readWorkflowBlob("name: Ship\n# dashboard: release\njobs:\n  build:\n    runs-on: x\n")).toMatchObject({
    marked: true,
    name: "Ship",
    jobs: [{ key: "build", needs: [] }],
  });
  // The mark is a comment line of its own, in any case.
  expect(readWorkflowBlob("jobs:\n  a:\n    runs-on: x # dashboard: release\n").marked).toBe(false);
  expect(readWorkflowBlob("  #  Dashboard: Release  \njobs:\n  a:\n    runs-on: x\n").marked).toBe(true);
  // A text that isn't a workflow has no name or jobs.
  expect(readWorkflowBlob("not: [a workflow")).toEqual({ marked: false, name: undefined, jobs: undefined });
});

const file = (path: string, text: string) => ({ path, blob: readWorkflowBlob(text) });
const JOBS = "jobs:\n  build:\n    runs-on: ubuntu-latest\n";

test("a repository that marks none of its files goes by their names", () => {
  const files = [
    file(".github/workflows/ci.yml", `name: CI\n${JOBS}`),
    file(".github/workflows/ship.yml", `name: Deploy to prod\n${JOBS}`),
    // Without a name, GitHub calls a workflow by its path.
    file(".github/workflows/release.yml", JOBS),
  ];
  expect(releasePaths(files)).toEqual([".github/workflows/ship.yml", ".github/workflows/release.yml"]);
});

test("once a file is marked, names no longer count", () => {
  const files = [
    file(".github/workflows/ci.yml", `name: CI\n# dashboard: release\n${JOBS}`),
    file(".github/workflows/release.yml", `name: Release\n${JOBS}`),
  ];
  expect(releasePaths(files)).toEqual([".github/workflows/ci.yml"]);
});

test("a file that couldn't be read is no release, unless its path says so", () => {
  expect(
    releasePaths([
      { path: ".github/workflows/ci.yml", blob: undefined },
      { path: ".github/workflows/deploy.yml", blob: undefined },
    ]),
  ).toEqual([".github/workflows/deploy.yml"]);
});
