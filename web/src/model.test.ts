import { expect, test } from "vitest";
import type { Check, CheckState } from "./model.ts";
import { summarize } from "./model.ts";

const checks = (...states: CheckState[]): Check[] =>
  states.map((state, index) => ({ name: `check ${index}`, state, url: undefined }));

test("no checks is its own answer", () => {
  expect(summarize([])).toBe("none");
});

test("the worst state wins", () => {
  expect(summarize(checks("passed", "skipped", "neutral"))).toBe("passed");
  expect(summarize(checks("passed", "queued"))).toBe("running");
  expect(summarize(checks("running", "waiting"))).toBe("waiting");
  expect(summarize(checks("waiting", "running", "failed"))).toBe("failed");
  expect(summarize(checks("passed", "cancelled"))).toBe("failed");
});
