import type { CheckState, Job, JobGraph, JobNode } from "../model.ts";

/** A matrix of up to this many jobs shows each of them as a card; a bigger one is one box with a grid of them. */
export const MATRIX_EXPANDED_MAX = 6;

/** More cards than this side by side in one stage read better as a row across, so the graph runs top to bottom. */
export const ROW_STAGE_MAX = 4;

/** One card on the graph. */
export type Card =
  /** One of the run's jobs. */
  | { kind: "job"; key: string; job: Job }
  /** A matrix too big for a card per job: one box, its state that of its jobs together. */
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

/**
 * Which way a graph runs:
 * - `row`: stages left to right, when they fit across.
 * - `timeline`: a single chain that doesn't fit across, one step under the other.
 * - `stack`: stages top to bottom, each stage's cards across; for a big matrix or a wide fan-out, or a graph that
 *   neither fits across nor is a single chain.
 */
export type Shape = "row" | "timeline" | "stack";

/**
 * The shape for a graph in a space `width` pixels wide. Until the width is known (0 or undefined) a graph that
 * doesn't have to be a stack is a row.
 */
export function pickShape(layout: Layout, width: number | undefined): Shape {
  const { stages } = layout;
  if (stages.some((cards) => cards.length > ROW_STAGE_MAX || cards.some((card) => card.kind === "group"))) {
    return "stack";
  }
  if (!width || rowWidth(layout) <= width) {
    return "row";
  }
  return stages.every((cards) => cards.length === 1) ? "timeline" : "stack";
}

/** About how wide a graph is as a row, in pixels: each stage as wide as its widest card, with the gaps between. */
export function rowWidth({ stages }: Layout): number {
  const cards = stages.reduce((sum, stage) => sum + Math.max(0, ...stage.map(cardWidth)), 0);
  return cards + STAGE_GAP * Math.max(0, stages.length - 1);
}

// Measured on the page's own look: 13px text, a 14px icon, the chip's padding and border.
const STAGE_GAP = 32;
const CHAR = 7;
const CHIP = 40;
const CARD_MAX = 288;

function cardWidth(card: Card): number {
  if (card.kind !== "job") {
    return Math.min(CARD_MAX, CHIP + CHAR * card.name.length);
  }
  const { job } = card;
  const tone = isLive(job.state) ? 1.12 : isTick(job.state) ? 0.92 : 1;
  // A job with a time shows it beside its name; a live one says what it is doing under it.
  const time = job.startedAt && !isLive(job.state) ? 48 : 0;
  return Math.min(CARD_MAX, Math.ceil(tone * (CHIP + CHAR * job.name.length) + time));
}

/** A job that is going on now, or waiting for someone: the one to look at. */
export function isLive(state: CheckState): boolean {
  return state === "running" || state === "waiting";
}

/** A job that finished with nothing to look at: drawn small, so the live ones stand out. */
export function isTick(state: CheckState): boolean {
  return state === "passed" || state === "neutral" || state === "skipped";
}
