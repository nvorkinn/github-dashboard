// @vitest-environment happy-dom
import { afterEach, expect, test } from "vitest";
import { applyTheme, chooseTheme, rememberedTheme } from "./theme.ts";

afterEach(() => {
  localStorage.clear();
  delete document.documentElement.dataset.theme;
});

test("follows the system until another theme is chosen", () => {
  expect(rememberedTheme()).toBe("auto");
  applyTheme(rememberedTheme());
  expect(document.documentElement.dataset.theme).toBeUndefined();
});

test("pins a chosen theme on the page and remembers it", () => {
  chooseTheme("dark");
  expect(document.documentElement.dataset.theme).toBe("dark");
  expect(rememberedTheme()).toBe("dark");

  chooseTheme("light");
  expect(document.documentElement.dataset.theme).toBe("light");
  expect(rememberedTheme()).toBe("light");
});

test("going back to auto takes the pin off and forgets it", () => {
  chooseTheme("light");
  chooseTheme("auto");
  expect(document.documentElement.dataset.theme).toBeUndefined();
  expect(localStorage.getItem("github-dashboard:theme")).toBeNull();
  expect(rememberedTheme()).toBe("auto");
});

test("ignores a stored value it doesn't know", () => {
  localStorage.setItem("github-dashboard:theme", "sepia");
  expect(rememberedTheme()).toBe("auto");
});
