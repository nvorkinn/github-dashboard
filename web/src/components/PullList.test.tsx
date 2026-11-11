// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/preact";
import { afterEach, expect, test } from "vitest";
import type { Check, CheckState } from "../model.ts";
import { PullList, sortChecks, sortPulls } from "./PullList.tsx";
import { before, NOW, pull } from "./testing.ts";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

const HOUR = 3_600_000;
const checks = (...states: CheckState[]): Check[] =>
  states.map((state, index) => ({ name: `check ${index + 1}`, state, url: undefined }));

/** The pull requests' numbers, in the order they are on the page. */
function numbers(): string[] {
  return screen.getAllByRole("listitem").flatMap((item) => item.querySelector(".number")?.textContent ?? []);
}

test("says so when there are none", () => {
  render(<PullList pulls={[]} now={NOW} />);
  expect(screen.getByText("No open pull requests")).toBeTruthy();
  expect(screen.getByRole("heading").textContent).toBe("Open pull requests 0");
});

test("draws a pull request", () => {
  render(
    <PullList
      now={NOW}
      pulls={[
        pull({
          number: 42,
          title: "Show wind gusts",
          head: "monalisa/wind-gusts",
          base: "main",
          createdAt: before(3 * 24 * HOUR),
          updatedAt: before(2 * HOUR),
        }),
      ]}
    />,
  );
  const row = screen.getByRole("listitem");
  const link = within(row).getByRole("link", { name: "#42 Show wind gusts" });
  expect(link.getAttribute("href")).toBe("https://github.com/octocat/weather-station/pull/1");
  expect(within(row).getByText("weather-station")).toBeTruthy();
  expect(within(row).getByText("monalisa")).toBeTruthy();
  expect(within(row).getByText("monalisa/wind-gusts")).toBeTruthy();
  expect(within(row).getByText("main")).toBeTruthy();
  expect(row.textContent).toContain("opened 3d ago");
  expect(row.textContent).toContain("updated 2h ago");
  expect(row.querySelector("img")?.getAttribute("src")).toBe("https://avatars.githubusercontent.com/u/1");
  expect(within(row).getByText("Ready to merge")).toBeTruthy();
  expect(within(row).getByText("No checks")).toBeTruthy();
  expect(within(row).queryByText("Draft")).toBeNull();
  expect(within(row).queryByText("Auto-merge")).toBeNull();
  expect(screen.getByRole("heading").textContent).toBe("Open pull requests 1");
});

test("does without an avatar when there is none", () => {
  const { container } = render(<PullList now={NOW} pulls={[pull({ authorAvatarUrl: undefined })]} />);
  expect(container.querySelector("img")).toBeNull();
});

test("marks drafts and auto-merge", () => {
  render(<PullList now={NOW} pulls={[pull({ draft: true, autoMerge: true })]} />);
  expect(screen.getByText("Draft")).toBeTruthy();
  expect(screen.getByText("Auto-merge")).toBeTruthy();
  // A draft isn't ready to merge, whatever its branch is like.
  expect(screen.queryByText("Ready to merge")).toBeNull();
});

test("says how the merge stands", () => {
  const words = { conflicts: "Conflicts", behind: "Behind base", blocked: "Blocked", unknown: "Merge state unknown" };
  for (const [mergeState, text] of Object.entries(words)) {
    render(<PullList now={NOW} pulls={[pull({ mergeState: mergeState as keyof typeof words })]} />);
    expect(screen.getByText(text)).toBeTruthy();
    cleanup();
  }
  render(<PullList now={NOW} pulls={[pull({ draft: true, mergeState: "conflicts" })]} />);
  expect(screen.getByText("Conflicts")).toBeTruthy();
});

test("sums the checks up in one word, with each of them behind it", () => {
  const cases: [CheckState[], string, string][] = [
    [["passed", "failed", "running"], "Failed", "1 failed, 1 running, 1 done"],
    [["passed", "cancelled"], "Failed", "1 cancelled, 1 done"],
    [["passed", "waiting", "running"], "Waiting", "1 waiting for approval, 1 running, 1 done"],
    [["passed", "queued"], "Running", "1 not started, 1 done"],
    [["passed", "skipped", "neutral"], "Passed", "1 done, 1 neutral, 1 skipped"],
  ];
  for (const [states, word, tally] of cases) {
    const { container } = render(<PullList now={NOW} pulls={[pull({ checks: checks(...states) })]} />);
    const summary = container.querySelector("summary");
    expect(summary?.querySelector(".chip")?.textContent).toBe(word);
    expect(summary?.querySelector(".tally")?.textContent).toBe(tally);
    // Closed until asked for.
    expect(container.querySelector("details")?.open).toBe(false);
    expect(container.querySelectorAll(".check-list li")).toHaveLength(states.length);
    cleanup();
  }
});

test("lists failed checks first, with a link where there is one", () => {
  const { container } = render(
    <PullList
      now={NOW}
      pulls={[
        pull({
          checks: [
            { name: "lint", state: "passed", url: undefined },
            { name: "build", state: "running", url: undefined },
            { name: "e2e", state: "failed", url: "https://github.com/octocat/weather-station/runs/7" },
          ],
        }),
      ]}
    />,
  );
  const items = [...container.querySelectorAll(".check-list li")].map((item) => item.textContent);
  expect(items).toEqual(["e2eFailed", "buildRunning", "lintDone"]);
  expect(screen.getByRole("link", { name: "e2e" }).getAttribute("href")).toBe(
    "https://github.com/octocat/weather-station/runs/7",
  );
  expect(screen.queryByRole("link", { name: "lint" })).toBeNull();
});

test("sorts checks by how much they need looking at", () => {
  const sorted = sortChecks(checks("skipped", "passed", "queued", "running", "waiting", "cancelled", "failed"));
  expect(sorted.map((check) => check.state)).toEqual([
    "failed",
    "cancelled",
    "waiting",
    "running",
    "queued",
    "passed",
    "skipped",
  ]);
});

const MIXED = [
  pull({ number: 1, createdAt: before(5 * HOUR), checks: checks("passed") }),
  pull({ number: 2, createdAt: before(4 * HOUR), checks: checks("running") }),
  pull({ number: 3, createdAt: before(3 * HOUR), checks: checks("waiting") }),
  pull({ number: 4, createdAt: before(2 * HOUR), checks: checks("failed") }),
  pull({ number: 5, createdAt: before(HOUR), checks: checks("passed"), mergeState: "conflicts" }),
  pull({ number: 6, createdAt: before(0) }),
];

test("orders by newest, oldest or attention", () => {
  const order = (by: Parameters<typeof sortPulls>[1]) => sortPulls(MIXED, by).map((one) => one.number);
  expect(order("newest")).toEqual([6, 5, 4, 3, 2, 1]);
  expect(order("oldest")).toEqual([1, 2, 3, 4, 5, 6]);
  // Failing and conflicting, then waiting, then running, then the rest; the newest first within each.
  expect(order("attention")).toEqual([5, 4, 3, 2, 6, 1]);
});

test("starts with the newest first and reorders on request", () => {
  render(<PullList now={NOW} pulls={MIXED} />);
  const select = screen.getByLabelText("Order") as HTMLSelectElement;
  expect(select.value).toBe("newest");
  expect(numbers()).toEqual(["#6", "#5", "#4", "#3", "#2", "#1"]);

  fireEvent.change(select, { target: { value: "attention" } });
  expect(numbers()).toEqual(["#5", "#4", "#3", "#2", "#6", "#1"]);

  fireEvent.change(select, { target: { value: "oldest" } });
  expect(numbers()).toEqual(["#1", "#2", "#3", "#4", "#5", "#6"]);
});

test("remembers the chosen order", () => {
  render(<PullList now={NOW} pulls={MIXED} />);
  fireEvent.change(screen.getByLabelText("Order"), { target: { value: "attention" } });
  cleanup();

  render(<PullList now={NOW} pulls={MIXED} />);
  expect((screen.getByLabelText("Order") as HTMLSelectElement).value).toBe("attention");
  expect(numbers()[0]).toBe("#5");
});

test("falls back to the newest first when what was remembered makes no sense", () => {
  localStorage.setItem("github-dashboard:pull-order", "sideways");
  render(<PullList now={NOW} pulls={MIXED} />);
  expect((screen.getByLabelText("Order") as HTMLSelectElement).value).toBe("newest");
});
