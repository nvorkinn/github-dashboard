// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/preact";
import { afterEach, expect, test } from "vitest";
import type { Check } from "../model.ts";
import { groupChecks, ReviewChecks, rememberedChecksOpen, withWorkflows } from "./ReviewChecks.tsx";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

const check = (name: string, state: Check["state"], workflow?: string): Check => ({
  name,
  state,
  url: `https://github.com/octo/app/runs/${name}`,
  ...(workflow ? { workflow } : {}),
});

test("groups checks by workflow, the worst first, with commit statuses last", () => {
  const groups = groupChecks([
    check("lint", "passed", "CI"),
    check("Global PR Status", "failed"),
    check("e2e", "running", "End-to-end"),
    check("build", "failed", "CI"),
  ]);
  expect(groups.map((group) => [group.workflow, group.checks.map((one) => one.name)])).toEqual([
    ["CI", ["build", "lint"]],
    ["End-to-end", ["e2e"]],
    [undefined, ["Global PR Status"]],
  ]);
});

test("fills in workflows by the check's address and leaves checks it doesn't know as they are", () => {
  const [a, b] = withWorkflows([check("a", "passed"), check("b", "passed")], {
    "https://github.com/octo/app/runs/a": "CI",
  });
  expect(a?.workflow).toBe("CI");
  expect(b?.workflow).toBeUndefined();
});

test("shows each check as a link under its workflow, and folds away, remembering it", () => {
  render(
    <ReviewChecks
      checks={[check("lint", "passed", "CI"), check("build", "failed", "CI"), check("e2e", "queued", "E2E")]}
    />,
  );
  const toggle = screen.getByRole("button", { name: /Checks/ });
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
  expect(toggle.textContent).toContain("Failed");
  expect(screen.getByText("CI")).toBeTruthy();
  expect(screen.getByText("E2E")).toBeTruthy();
  const build = screen.getByRole("link", { name: /build/ });
  expect(build.getAttribute("href")).toBe("https://github.com/octo/app/runs/build");
  expect(build.textContent).toContain("Failed");

  fireEvent.click(toggle);
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  expect(screen.queryByRole("link", { name: /build/ })).toBeNull();
  expect(rememberedChecksOpen()).toBe(false);
});

test("lists one workflow's checks without a heading, and says when there are none", () => {
  const { unmount } = render(<ReviewChecks checks={[check("lint", "passed", "CI")]} />);
  expect(screen.queryByText("CI")).toBeNull();
  expect(screen.getByRole("link", { name: /lint/ })).toBeTruthy();
  unmount();
  render(<ReviewChecks checks={[]} />);
  expect(screen.getByText("No checks on this commit.")).toBeTruthy();
});

test("starts folded when it was folded last time", () => {
  localStorage.setItem("github-dashboard:review-checks", "closed");
  render(<ReviewChecks checks={[check("lint", "passed")]} />);
  expect(screen.getByRole("button", { name: /Checks/ }).getAttribute("aria-expanded")).toBe("false");
});
