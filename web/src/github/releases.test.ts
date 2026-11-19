import { expect, test } from "vitest";
import type { ReleaseRun } from "../../../shared/runs.ts";
import { releaseRun, releasesSnapshot, withRun } from "./releases.ts";

const JOB = {
  id: 11,
  name: "build",
  state: "running",
  url: "https://github.com/octo/app/actions/runs/1/job/11",
  startedAt: "2026-11-14T12:01:00Z",
};
// As the relay writes it: what is undefined in the model is left out of the JSON.
const RUN = {
  repo: "octo/app",
  id: 1,
  workflow: "Release",
  number: 101,
  title: "v1.2.3",
  tag: "v1.2.3",
  url: "https://github.com/octo/app/actions/runs/1",
  state: "waiting",
  actor: "octocat",
  startedAt: "2026-11-14T12:00:00Z",
  jobs: [JOB],
  graph: {
    nodes: [
      { key: "build", name: "build", needs: [], several: false, jobs: [JOB] },
      { key: "deploy", name: "Deploy", needs: ["build"], several: true, jobs: [] },
    ],
    unplaced: [],
  },
  approvals: [{ environmentId: 7, environment: "production", canApprove: false }],
};

test("a run the relay sent is read whole, with what its JSON leaves out as undefined", () => {
  const job = { ...JOB, finishedAt: undefined };
  expect(releaseRun(JSON.parse(JSON.stringify(RUN)))).toEqual({
    ...RUN,
    finishedAt: undefined,
    jobs: [job],
    graph: { nodes: [{ ...RUN.graph.nodes[0], jobs: [job] }, RUN.graph.nodes[1]], unplaced: [] },
  });
  // A finished run: no jobs, no graph, no tag.
  const { graph: _, tag: __, ...finished } = { ...RUN, state: "passed", finishedAt: "2026-11-14T12:30:00Z", jobs: [] };
  expect(releaseRun(finished)).toEqual({ ...finished, actor: "octocat" });
});

test.each([
  ["not an object", "run"],
  ["no id", { ...RUN, id: undefined }],
  ["a number that isn't one", { ...RUN, number: "101" }],
  ["a state that is none", { ...RUN, state: "exploded" }],
  ["a link that leaves github.com", { ...RUN, url: "https://evil.example/run" }],
  ["a job's link that does", { ...RUN, jobs: [{ ...JOB, url: "javascript:alert(1)" }] }],
  ["a job without a name", { ...RUN, jobs: [{ ...JOB, name: undefined }] }],
  ["a graph that isn't one", { ...RUN, graph: { nodes: "all of them", unplaced: [] } }],
  [
    "a node whose needs aren't names",
    { ...RUN, graph: { nodes: [{ ...RUN.graph.nodes[0], needs: [1] }], unplaced: [] } },
  ],
  ["approvals that aren't", { ...RUN, approvals: [{ environment: "production" }] }],
  ["no jobs", { ...RUN, jobs: undefined }],
])("a run with %s is no run", (_, value) => {
  expect(releaseRun(value)).toBeUndefined();
});

test("everything the relay knows is read, or nothing of it if any of it is wrong", () => {
  const snapshot = { configured: true, projects: { "octo/app": { promoteWorkflow: 31 }, "octo/lib": {} }, runs: [RUN] };
  expect(releasesSnapshot(snapshot)).toMatchObject({
    configured: true,
    projects: { "octo/app": { promoteWorkflow: 31 }, "octo/lib": {} },
    runs: [{ id: 1 }],
  });
  expect(releasesSnapshot({ configured: false, projects: {}, runs: [] })).toEqual({
    configured: false,
    projects: {},
    runs: [],
  });
  // A Promote workflow's id that is no number is no Promote workflow.
  expect(releasesSnapshot({ ...snapshot, projects: { "octo/app": { promoteWorkflow: "31" } } })?.projects).toEqual({
    "octo/app": {},
  });
  expect(releasesSnapshot({ ...snapshot, runs: [RUN, { ...RUN, id: "2" }] })).toBeUndefined();
  expect(releasesSnapshot({ ...snapshot, configured: "yes" })).toBeUndefined();
  expect(releasesSnapshot({ ...snapshot, projects: [] })).toBeUndefined();
  expect(releasesSnapshot(undefined)).toBeUndefined();
});

test("a run takes the place of the one it was, or joins the others, the last started first", () => {
  const run = (id: number, startedAt: string, repo = "octo/app") =>
    ({ ...releaseRun(RUN), repo, id, startedAt }) as ReleaseRun;
  const runs = [run(2, "2026-11-14T13:00:00Z"), run(1, "2026-11-14T12:00:00Z")];
  const changed = { ...run(1, "2026-11-14T12:00:00Z"), state: "passed" as const };
  expect(withRun(runs, changed)).toEqual([runs[0], changed]);
  expect(withRun(runs, run(3, "2026-11-14T12:30:00Z")).map((one) => one.id)).toEqual([2, 3, 1]);
  // The same id in another repository is another run.
  expect(withRun(runs, run(1, "2026-11-14T14:00:00Z", "octo/lib")).map((one) => one.repo)).toEqual([
    "octo/lib",
    "octo/app",
    "octo/app",
  ]);
});
