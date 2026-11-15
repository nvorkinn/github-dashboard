import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { MergeUpdate } from "../../shared/pulls.ts";
import { createMergeStates, RETRY_MS } from "./merge_states.ts";
import { fakeApp, settle } from "./testing.ts";

const REPO = "octo/app";
const sha = (n: number) => `${n}`.padStart(40, "a");

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
});
afterEach(() => {
  vi.useRealTimers();
});

type Node = { number: number; mergeable: string; mergeStateStatus: string; state?: string; baseRefName?: string };

function node(one: Node) {
  return { state: "OPEN", baseRefName: "main", headRefOid: sha(one.number), ...one };
}

/**
 * Merge states on a fake GitHub where each pull request's answers come from `answers`, one per query that asks of it
 * (the last one from then on). `queries` are the variables and the pull requests asked of, by number, for each query.
 */
function setUp(answers: Record<number, Node[]>, options: { listening?: () => boolean } = {}) {
  const updates: MergeUpdate[] = [];
  const queries: { numbers: number[]; variables: Record<string, unknown> }[] = [];
  const asked = new Map<number, number>();
  const answer = (number: number) => {
    const all = answers[number] ?? [];
    const index = asked.get(number) ?? 0;
    asked.set(number, index + 1);
    return all[Math.min(index, all.length - 1)];
  };
  const { app, calls } = fakeApp([{ repo: REPO }], {
    graphql: (query: string, variables: Record<string, unknown>) => {
      const byNumber = [...query.matchAll(/p(\d+): pullRequest/g)].map((match) => Number(match[1]));
      if (byNumber.length > 0) {
        queries.push({ numbers: byNumber, variables });
        return {
          repository: Object.fromEntries(byNumber.map((number) => [`p${number}`, node(answer(number) as Node)])),
        };
      }
      const numbers = Object.keys(answers).map(Number);
      queries.push({ numbers, variables });
      return {
        repository: {
          pullRequests: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: numbers.map((number) => node(answer(number) as Node)),
          },
        },
      };
    },
  });
  const states = createMergeStates({
    app,
    onUpdate: (update) => updates.push(update),
    listening: options.listening ?? (() => true),
  });
  return { states, updates, queries, calls };
}

function push(ref = "refs/heads/main", more: Record<string, unknown> = {}) {
  return { ref, after: sha(99), repository: { full_name: REPO }, installation: { id: 7 }, ...more };
}

const unknown = (number: number): Node => ({ number, mergeable: "UNKNOWN", mergeStateStatus: "UNKNOWN" });
const clean = (number: number): Node => ({ number, mergeable: "MERGEABLE", mergeStateStatus: "CLEAN" });
const conflicts = (number: number): Node => ({ number, mergeable: "CONFLICTING", mergeStateStatus: "DIRTY" });

test("a push asks about the open pull requests into the branch, and tells every one of them", async () => {
  const { states, updates, queries } = setUp({ 1: [clean(1)], 2: [conflicts(2)], 3: [unknown(3), clean(3)] });
  states.onWebhook("push", push());
  await settle();
  expect(queries).toEqual([
    { numbers: [1, 2, 3], variables: { owner: "octo", name: "app", base: "main", after: null } },
  ]);
  expect(updates).toEqual([
    {
      repo: REPO,
      base: "main",
      pulls: [
        { number: 1, sha: sha(1), mergeState: "clean" },
        { number: 2, sha: sha(2), mergeState: "conflicts" },
        { number: 3, sha: sha(3), mergeState: "unknown" },
      ],
    },
  ]);
});

test("the unknown ones are asked about again after 2, 4, 8 and 16 seconds, and told once GitHub knows", async () => {
  const { states, updates, queries } = setUp({
    1: [unknown(1), unknown(1), clean(1)],
    2: [unknown(2)],
    3: [clean(3)],
  });
  states.onWebhook("push", push());
  await settle();
  expect(queries).toHaveLength(1);

  await vi.advanceTimersByTimeAsync(RETRY_MS[0] - 1);
  expect(queries).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(1);
  // Only the ones still unknown; GitHub hasn't worked out either yet, so nothing is told.
  expect(queries.at(-1)?.numbers).toEqual([1, 2]);
  expect(updates).toHaveLength(1);

  await vi.advanceTimersByTimeAsync(RETRY_MS[1]);
  expect(queries.at(-1)?.numbers).toEqual([1, 2]);
  expect(updates.at(-1)).toEqual({
    repo: REPO,
    base: "main",
    pulls: [{ number: 1, sha: sha(1), mergeState: "clean" }],
  });

  await vi.advanceTimersByTimeAsync(RETRY_MS[2]);
  await vi.advanceTimersByTimeAsync(RETRY_MS[3]);
  expect(queries.map((one) => one.numbers)).toEqual([[1, 2, 3], [1, 2], [1, 2], [2], [2]]);
  // Five tries in all: what is still unknown stays so.
  await vi.advanceTimersByTimeAsync(60_000);
  expect(queries).toHaveLength(5);
  expect(updates).toHaveLength(2);
});

test("a push while a loop is going ends it and starts over", async () => {
  const { states, queries } = setUp({ 1: [unknown(1)] });
  states.onWebhook("push", push());
  await settle();
  await vi.advanceTimersByTimeAsync(RETRY_MS[0] + RETRY_MS[1]);
  expect(queries).toHaveLength(3);

  states.onWebhook("push", push());
  await settle();
  expect(queries).toHaveLength(4);
  // The old loop's next try, 8 seconds on, never comes; the new one's come at 2, 4, 8 and 16 seconds from its start.
  await vi.advanceTimersByTimeAsync(RETRY_MS[0]);
  expect(queries).toHaveLength(5);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(queries).toHaveLength(8);
});

test("a push to another repository has a loop of its own", async () => {
  const { states, queries } = setUp({ 1: [unknown(1)] });
  states.onWebhook("push", push());
  states.onWebhook("push", push("refs/heads/main", { repository: { full_name: "octo/lib" } }));
  await settle();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(queries).toHaveLength(10);
  expect(queries.filter((one) => one.variables.name === "lib")).toHaveLength(5);
});

test("a pull request that closed or moved to another base is told no more", async () => {
  const { states, updates, queries } = setUp({
    1: [unknown(1), { ...clean(1), state: "CLOSED" }],
    2: [unknown(2), { ...clean(2), baseRefName: "other" }],
  });
  states.onWebhook("push", push());
  await settle();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(updates).toHaveLength(1);
  expect(queries).toHaveLength(2);
});

test("nothing is asked while no page is open, and a loop stops when the last one closes", async () => {
  let open = false;
  const { states, queries } = setUp({ 1: [unknown(1)] }, { listening: () => open });
  states.onWebhook("push", push());
  await settle();
  expect(queries).toEqual([]);

  open = true;
  states.onWebhook("push", push());
  await settle();
  open = false;
  await vi.advanceTimersByTimeAsync(60_000);
  expect(queries).toHaveLength(1);
});

test.each([
  ["a tag", push("refs/tags/v1")],
  ["a deleted branch", push("refs/heads/main", { deleted: true })],
  ["no installation", push("refs/heads/main", { installation: undefined })],
])("a push of %s asks nothing", async (_, payload) => {
  const { states, calls } = setUp({ 1: [unknown(1)] });
  states.onWebhook("push", payload);
  states.onWebhook("pull_request", { ...push(), action: "opened" });
  await settle();
  expect(calls).toEqual([]);
});

test("GitHub failing ends the loop quietly", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const updates: MergeUpdate[] = [];
  const { app, calls } = fakeApp([{ repo: REPO }], { graphql: () => 502 });
  const states = createMergeStates({ app, onUpdate: (update) => updates.push(update), listening: () => true });
  states.onWebhook("push", push());
  await settle();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(calls).toEqual(["graphql"]);
  expect(updates).toEqual([]);
  expect(warn).toHaveBeenCalledWith("merge states of octo/app not read: HTTP 502");
  warn.mockRestore();
});
