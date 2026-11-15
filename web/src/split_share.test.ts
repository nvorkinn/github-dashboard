// @vitest-environment happy-dom
import { afterEach, expect, test } from "vitest";
import { clampSplitShare, rememberedSplitShare, rememberSplitShare } from "./split_share.ts";

afterEach(() => localStorage.clear());

test("starts with even halves", () => {
  expect(rememberedSplitShare()).toBeUndefined();
});

test("remembers a chosen share, and forgets it on going back to halves", () => {
  rememberSplitShare(0.62);
  expect(rememberedSplitShare()).toBe(0.62);
  rememberSplitShare(undefined);
  expect(localStorage.getItem("github-dashboard:review-split")).toBeNull();
  expect(rememberedSplitShare()).toBeUndefined();
});

test("ignores a stored value that is no usable share", () => {
  for (const value of ["wide", "", "0.05", "0.95", "40", "NaN"]) {
    localStorage.setItem("github-dashboard:review-split", value);
    expect(rememberedSplitShare()).toBeUndefined();
  }
});

test("keeps both sides readable", () => {
  expect(clampSplitShare(0)).toBe(0.15);
  expect(clampSplitShare(0.43219)).toBe(0.432);
  expect(clampSplitShare(1)).toBe(0.85);
});
