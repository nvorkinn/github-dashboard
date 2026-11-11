import { expect, test } from "vitest";
import type { CheckState, Job, JobNode } from "../model.ts";
import { type Card, groupState, layoutGraph, MATRIX_EXPANDED_MAX } from "./graph_layout.ts";

let nextId = 1;
const job = (state: CheckState = "passed"): Job => ({
  id: nextId++,
  name: `job ${nextId}`,
  state,
  url: undefined,
  startedAt: undefined,
  finishedAt: undefined,
});

const node = (key: string, needs: string[] = [], jobs: Job[] = [job()]): JobNode => ({
  key,
  name: key,
  needs,
  several: jobs.length > 1,
  jobs,
});

const keys = (stages: Card[][]) => stages.map((cards) => cards.map((card) => card.key));

test("puts each job one column right of the last job it waits for", () => {
  const { stages, edges } = layoutGraph({
    nodes: [node("tag"), node("lint"), node("build", ["tag"]), node("image", ["tag", "build"]), node("notes", ["tag"])],
    unplaced: [],
  });
  expect(keys(stages)).toEqual([["node-tag", "node-lint"], ["node-build", "node-notes"], ["node-image"]]);
  expect(edges).toEqual([
    { from: "node-tag", to: "node-build" },
    { from: "node-tag", to: "node-image" },
    { from: "node-build", to: "node-image" },
    { from: "node-tag", to: "node-notes" },
  ]);
});

test("puts the jobs that match no job of the file in a last column", () => {
  const lost = job("failed");
  const { stages } = layoutGraph({ nodes: [node("a"), node("b", ["a"])], unplaced: [lost] });
  expect(keys(stages)).toEqual([["node-a"], ["node-b"], [`job-${lost.id}`]]);
});

test("survives a loop of needs", () => {
  const { stages } = layoutGraph({ nodes: [node("a", ["b"]), node("b", ["a"]), node("c", ["c"])], unplaced: [] });
  expect(stages.flat()).toHaveLength(3);
});

test("shows a small matrix job by job, and a big one as one card", () => {
  const small = Array.from({ length: MATRIX_EXPANDED_MAX }, () => job());
  const big = [job("passed"), job("failed"), ...Array.from({ length: MATRIX_EXPANDED_MAX }, () => job("queued"))];
  const { stages, edges } = layoutGraph({
    nodes: [node("tag"), node("small", ["tag"], small), node("big", ["small"], big), node("later", ["big"], [])],
    unplaced: [],
  });
  expect(keys(stages)).toEqual([["node-tag"], small.map((one) => `job-${one.id}`), ["node-big"], ["node-later"]]);
  expect(stages[2]?.[0]).toMatchObject({ kind: "group", name: "big", jobs: big, state: "failed", done: 2 });
  // A job of the file that the run has no job for yet.
  expect(stages[3]?.[0]).toEqual({ kind: "pending", key: "node-later", name: "later" });
  // Every job of the small matrix waits for tag, and the big one for every one of them.
  expect(edges.filter((edge) => edge.to === "node-big")).toHaveLength(MATRIX_EXPANDED_MAX);
  expect(edges.filter((edge) => edge.from === "node-tag")).toHaveLength(MATRIX_EXPANDED_MAX);
});

test.each<[CheckState[], CheckState]>([
  [["passed", "failed", "running"], "failed"],
  [["passed", "cancelled"], "cancelled"],
  [["waiting", "running"], "waiting"],
  [["passed", "queued"], "running"],
  [["queued", "queued"], "queued"],
  [["skipped", "skipped"], "skipped"],
  [["passed", "skipped"], "passed"],
  [["neutral", "skipped"], "neutral"],
])("a matrix of %j is %s", (states, expected) => {
  expect(groupState(states.map(job))).toBe(expected);
});
