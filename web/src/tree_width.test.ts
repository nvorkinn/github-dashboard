// @vitest-environment happy-dom
import { afterEach, expect, test } from "vitest";
import { clampTreeWidth, rememberedTreeWidth, rememberTreeWidth } from "./tree_width.ts";

afterEach(() => localStorage.clear());

test("starts with no chosen width, leaving it to the stylesheet", () => {
  expect(rememberedTreeWidth()).toBeUndefined();
});

test("remembers a chosen width, and forgets it on going back to the default", () => {
  rememberTreeWidth(420);
  expect(rememberedTreeWidth()).toBe(420);
  rememberTreeWidth(undefined);
  expect(localStorage.getItem("github-dashboard:review-tree-width")).toBeNull();
  expect(rememberedTreeWidth()).toBeUndefined();
});

test("ignores a stored value that is no usable width", () => {
  for (const value of ["wide", "-40", "12", "Infinity"]) {
    localStorage.setItem("github-dashboard:review-tree-width", value);
    expect(rememberedTreeWidth()).toBeUndefined();
  }
});

test("keeps the tree readable and leaves the diff most of the overlay", () => {
  expect(clampTreeWidth(50, 1000)).toBe(180);
  expect(clampTreeWidth(300.4, 1000)).toBe(300);
  expect(clampTreeWidth(900, 1000)).toBe(600);
  expect(clampTreeWidth(900, 200)).toBe(180);
});
