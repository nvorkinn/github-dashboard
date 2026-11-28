import { expect, test } from "vitest";
import { pull } from "./components/testing.ts";
import { findStacks, groupStacks } from "./stacks.ts";

const a = pull({ number: 1, head: "a", base: "main" });
const b = pull({ number: 2, head: "b", base: "a" });
const c = pull({ number: 3, head: "c", base: "b" });
const lone = pull({ number: 9, head: "lone", base: "main" });

const numbers = (pulls: { number: number }[]) => pulls.map((one) => one.number);

test("a pull request based on another's branch is stacked on it, bottom first", () => {
  const places = findStacks([c, lone, a, b]);
  expect(places.has("octocat/weather-station#9")).toBe(false);
  const top = places.get("octocat/weather-station#3");
  expect(top).toMatchObject({ under: b, position: 3, size: 3, into: "main", native: false });
  expect(numbers(top?.below ?? [])).toEqual([1, 2]);
  expect(places.get("octocat/weather-station#1")).toMatchObject({ under: undefined, position: 1 });
});

test("branches of the same name in different projects don't stack", () => {
  const elsewhere = pull({ repo: "octocat/other", number: 5, head: "x", base: "a" });
  expect(findStacks([a, elsewhere]).size).toBe(0);
});

test("a GitHub stack goes by GitHub's places, and its members merge with those under them", () => {
  const x = pull({ number: 11, head: "x", base: "main", stack: { number: 2, size: 2, position: 1 } });
  // GitHub has the base as the branch it goes into once the one under it is in.
  const y = pull({ number: 12, head: "y", base: "elsewhere", stack: { number: 2, size: 2, position: 2 } });
  const places = findStacks([y, x]);
  expect(places.get("octocat/weather-station#12")).toMatchObject({ under: x, native: true, position: 2 });
});

test("a list keeps each stack together, where its first member comes, bottom first", () => {
  const places = findStacks([a, b, c, lone]);
  const groups = groupStacks([c, lone, a, b], places);
  expect(groups.map((group) => ("pull" in group ? group.pull.number : numbers(group.stack)))).toEqual([[1, 2, 3], 9]);
});

test("a stack filtered down to one member shows it on its own, and a gap keeps the rest together", () => {
  const places = findStacks([a, b, c]);
  expect(groupStacks([b], places)).toEqual([{ pull: b }]);
  expect(groupStacks([c, a], places)).toEqual([{ stack: [a, c], into: "main" }]);
});
