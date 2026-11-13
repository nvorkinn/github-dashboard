// @vitest-environment happy-dom
import { afterEach, expect, test } from "vitest";
import { rememberDiffFontSize, rememberedDiffFontSize } from "./diff_font.ts";

afterEach(() => localStorage.clear());

test("starts at medium, a step down from the size the diff always had", () => {
  expect(rememberedDiffFontSize()).toBe("medium");
});

test("remembers a chosen size, and forgets it on going back to the default", () => {
  rememberDiffFontSize("large");
  expect(rememberedDiffFontSize()).toBe("large");
  rememberDiffFontSize("small");
  expect(rememberedDiffFontSize()).toBe("small");
  rememberDiffFontSize("medium");
  expect(localStorage.getItem("github-dashboard:diff-font-size")).toBeNull();
  expect(rememberedDiffFontSize()).toBe("medium");
});

test("ignores a stored value it doesn't know", () => {
  localStorage.setItem("github-dashboard:diff-font-size", "huge");
  expect(rememberedDiffFontSize()).toBe("medium");
});
