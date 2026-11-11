import type { CheckState, Job, JobGraph, JobNode } from "../model.ts";

/** A matrix of up to this many jobs shows each of them; a bigger one is one card that opens into them. */
export const MATRIX_EXPANDED_MAX = 6;

/** One card on the graph. */
export type Card =
  /** One of the run's jobs. */
  | { kind: "job"; key: string; job: Job }
  /** A matrix too big to show job by job: its state is that of its jobs together. */
  | { kind: "group"; key: string; name: string; jobs: Job[]; state: CheckState; done: number }
  /** A job of the file the run has no job for yet. */
  | { kind: "pending"; key: string; name: string };

export type Layout = {
  /** The columns, left to right: a job is one column right of the last of the jobs it waits for. */
  stages: Card[][];
  /** Lines from a card to a card that waits for it, by their keys. */
  edges: { from: string; to: string }[];
};

/**
 * Where each card of a run's graph goes. Jobs that wait for nothing start the first column; the run's jobs that match
 * no job of the file go in a column of their own after the rest.
 */
export function layoutGraph(graph: JobGraph): Layout {
  const byKey = new Map(graph.nodes.map((node) => [node.key, node]));
  const depths = new Map<string, number>();
  function depth(node: JobNode, visiting: Set<string>): number {
    const known = depths.get(node.key);
    if (known !== undefined) {
      return known;
    }
    // A loop of needs (which GitHub would refuse to run) is cut where it closes.
    if (visiting.has(node.key)) {
      return -1;
    }
    visiting.add(node.key);
    let value = 0;
    for (const key of node.needs) {
      const parent = byKey.get(key);
      if (parent) {
        value = Math.max(value, depth(parent, visiting) + 1);
      }
    }
    visiting.delete(node.key);
    depths.set(node.key, value);
    return value;
  }

  const cardsOf = new Map<string, Card[]>();
  const stages: Card[][] = [];
  for (const node of graph.nodes) {
    const column = depth(node, new Set());
    const cards = cardsFor(node);
    cardsOf.set(node.key, cards);
    while (stages.length <= column) {
      stages.push([]);
    }
    stages[column]?.push(...cards);
  }
  if (graph.unplaced.length > 0) {
    stages.push(graph.unplaced.map((job) => ({ kind: "job", key: `job-${job.id}`, job })));
  }

  const edges: Layout["edges"] = [];
  for (const node of graph.nodes) {
    for (const need of new Set(node.needs)) {
      for (const from of cardsOf.get(need) ?? []) {
        for (const to of cardsOf.get(node.key) ?? []) {
          edges.push({ from: from.key, to: to.key });
        }
      }
    }
  }
  return { stages, edges };
}

function cardsFor(node: JobNode): Card[] {
  const key = `node-${node.key}`;
  if (node.jobs.length === 0) {
    return [{ kind: "pending", key, name: node.name }];
  }
  if (node.jobs.length > MATRIX_EXPANDED_MAX) {
    return [
      {
        kind: "group",
        key,
        name: node.name,
        jobs: node.jobs,
        state: groupState(node.jobs),
        done: node.jobs.filter((job) => FINISHED.includes(job.state)).length,
      },
    ];
  }
  return node.jobs.map((job) => ({ kind: "job", key: node.jobs.length === 1 ? key : `job-${job.id}`, job }));
}

const FINISHED: CheckState[] = ["passed", "failed", "cancelled", "skipped", "neutral"];

/** Several jobs' state as one: the one that most needs looking at. */
export function groupState(jobs: Job[]): CheckState {
  const states = new Set(jobs.map((job) => job.state));
  for (const state of ["failed", "cancelled", "waiting", "running"] as const) {
    if (states.has(state)) {
      return state;
    }
  }
  if (states.has("queued")) {
    // Some have finished and some not yet: the matrix is under way.
    return states.size > 1 ? "running" : "queued";
  }
  if ([...states].every((state) => state === "skipped")) {
    return "skipped";
  }
  return states.has("passed") ? "passed" : "neutral";
}
