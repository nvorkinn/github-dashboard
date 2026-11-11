// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/preact";
import { afterEach, expect, test, vi } from "vitest";
import type { Check, CheckState, PullActions, PullRequest } from "../model.ts";
import { ActionsContext, CONFIRM_MS } from "./actions.tsx";
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

/** Pull request actions that wait until the test lets them finish. */
function fakeActions() {
  const pending: { resolve: (value: unknown) => void; reject: (error: unknown) => void }[] = [];
  const wait = <T,>() =>
    new Promise<T>((resolve, reject) => pending.push({ resolve: resolve as (value: unknown) => void, reject }));
  const actions = {
    setAutoMerge: vi.fn((_pull: PullRequest, _enabled: boolean) => wait<{ merged: boolean }>()),
    merge: vi.fn((_pull: PullRequest) => wait<void>()),
    updateBranch: vi.fn((_pull: PullRequest) => wait<void>()),
  } satisfies PullActions;
  return {
    actions,
    /** Lets the action under way finish with `value`, or fail with `error`. */
    async finish(value?: unknown, error?: unknown) {
      const one = pending.shift();
      if (!one) {
        throw new Error("No action is under way");
      }
      await act(async () => {
        if (error === undefined) {
          one.resolve(value);
        } else {
          one.reject(error);
        }
        // What the page does once it is through takes a few turns of the event loop's microtasks.
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    },
  };
}

function withActions(pulls: PullRequest[], actions: PullActions | null = fakeActions().actions) {
  return render(
    <ActionsContext.Provider value={actions ? { pulls: actions } : {}}>
      <PullList now={NOW} pulls={pulls} />
    </ActionsContext.Provider>,
  );
}

const buttons = () => screen.queryAllByRole("button").map((button) => button.textContent);

test("has no buttons where nothing can be done", () => {
  render(<PullList now={NOW} pulls={[pull()]} />);
  expect(buttons()).toEqual([]);
  cleanup();
  withActions([pull()], null);
  expect(buttons()).toEqual([]);
});

test("offers what can be done now", () => {
  const cases: [Partial<PullRequest>, string[]][] = [
    [{ mergeState: "clean" }, ["Merge", "Auto-merge"]],
    [{ mergeState: "clean", autoMerge: true }, ["Merge", "Cancel auto-merge"]],
    [{ mergeState: "behind" }, ["Update branch", "Auto-merge"]],
    [{ mergeState: "blocked" }, ["Auto-merge"]],
    [{ mergeState: "conflicts" }, ["Auto-merge"]],
    // A draft can't be merged or have auto-merge turned on, but can be updated, and auto-merge turned off.
    [{ mergeState: "clean", draft: true }, []],
    [{ mergeState: "behind", draft: true }, ["Update branch"]],
    [{ mergeState: "blocked", draft: true, autoMerge: true }, ["Cancel auto-merge"]],
  ];
  for (const [fields, expected] of cases) {
    withActions([pull(fields)]);
    expect(buttons(), JSON.stringify(fields)).toEqual(expected);
    if (expected.length > 0) {
      expect(screen.getByRole("group").getAttribute("aria-label")).toBe("Actions for #1 in weather-station");
    }
    cleanup();
  }
});

test("merging asks to confirm in place, and goes back to the plain button after a few seconds", () => {
  vi.useFakeTimers();
  try {
    const { actions } = fakeActions();
    withActions([pull()], actions);
    fireEvent.click(screen.getByRole("button", { name: "Merge" }));
    expect(buttons()).toEqual(["Confirm merge", "Cancel", "Auto-merge"]);
    expect(document.activeElement?.textContent).toBe("Confirm merge");
    expect(actions.merge).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(buttons()).toEqual(["Merge", "Auto-merge"]);

    fireEvent.click(screen.getByRole("button", { name: "Merge" }));
    act(() => {
      vi.advanceTimersByTime(CONFIRM_MS - 1);
    });
    expect(buttons()).toContain("Confirm merge");
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(buttons()).toEqual(["Merge", "Auto-merge"]);
    expect(actions.merge).not.toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
  }
});

test("a confirmed merge shows while it runs, and then that it merged", async () => {
  const { actions, finish } = fakeActions();
  const shown = pull({ number: 7 });
  withActions([shown], actions);
  fireEvent.click(screen.getByRole("button", { name: "Merge" }));
  fireEvent.click(screen.getByRole("button", { name: "Confirm merge" }));
  expect(actions.merge).toHaveBeenCalledExactlyOnceWith(shown);
  expect(buttons()).toEqual(["Merging…", "Auto-merge"]);
  for (const button of screen.getAllByRole("button")) {
    expect((button as HTMLButtonElement).disabled).toBe(true);
  }
  // A second click while it runs starts nothing.
  fireEvent.click(screen.getByRole("button", { name: "Auto-merge" }));
  expect(actions.setAutoMerge).not.toHaveBeenCalled();

  await finish();
  expect(screen.getByText("Merged")).toBeTruthy();
  expect(screen.queryByText("Ready to merge")).toBeNull();
  expect(buttons()).toEqual([]);
});

test("turning auto-merge on and off shows at once, until the pull request is read again", async () => {
  const { actions, finish } = fakeActions();
  const shown = pull();
  const { rerender } = withActions([shown], actions);
  fireEvent.click(screen.getByRole("button", { name: "Auto-merge" }));
  expect(actions.setAutoMerge).toHaveBeenCalledExactlyOnceWith(shown, true);
  expect(buttons()).toEqual(["Merge", "Turning on…"]);
  await finish({ merged: false });
  expect(screen.getByText("Auto-merge", { selector: ".badge" })).toBeTruthy();
  expect(buttons()).toEqual(["Merge", "Cancel auto-merge"]);

  fireEvent.click(screen.getByRole("button", { name: "Cancel auto-merge" }));
  expect(actions.setAutoMerge).toHaveBeenLastCalledWith(expect.objectContaining({ autoMerge: true }), false);
  expect(buttons()).toEqual(["Merge", "Turning off…"]);
  await finish({ merged: false });
  expect(screen.queryByText("Auto-merge", { selector: ".badge" })).toBeNull();

  // What GitHub says, once read again, is what shows.
  rerender(
    <ActionsContext.Provider value={{ pulls: actions }}>
      <PullList now={NOW} pulls={[pull({ autoMerge: true })]} />
    </ActionsContext.Provider>,
  );
  expect(screen.getByText("Auto-merge", { selector: ".badge" })).toBeTruthy();
});

test("auto-merge that merged at once, as nothing was required, shows that it merged", async () => {
  const { actions, finish } = fakeActions();
  withActions([pull({ mergeState: "blocked" })], actions);
  fireEvent.click(screen.getByRole("button", { name: "Auto-merge" }));
  await finish({ merged: true });
  expect(screen.getByText("Merged")).toBeTruthy();
  expect(buttons()).toEqual([]);
});

test("updating the branch shows until its head is the new commit", async () => {
  const { actions, finish } = fakeActions();
  const shown = pull({ mergeState: "behind", sha: "old" });
  const { rerender } = withActions([shown], actions);
  fireEvent.click(screen.getByRole("button", { name: "Update branch" }));
  expect(actions.updateBranch).toHaveBeenCalledExactlyOnceWith(shown);
  expect(buttons()).toEqual(["Updating…", "Auto-merge"]);
  await finish();
  expect(screen.getByText("Updating branch")).toBeTruthy();
  expect(screen.queryByText("Behind base")).toBeNull();
  expect(buttons()).toEqual(["Auto-merge"]);

  const again = (fields: Partial<PullRequest>) =>
    rerender(
      <ActionsContext.Provider value={{ pulls: actions }}>
        <PullList now={NOW} pulls={[pull({ mergeState: "behind", ...fields })]} />
      </ActionsContext.Provider>,
    );
  // Read again before GitHub got to it: still the old head.
  again({ sha: "old" });
  expect(screen.getByText("Updating branch")).toBeTruthy();
  again({ sha: "new", mergeState: "blocked" });
  expect(screen.queryByText("Updating branch")).toBeNull();
  expect(screen.getByText("Blocked")).toBeTruthy();
});

test("an action that fails says why next to its buttons, until the next one starts", async () => {
  const { actions, finish } = fakeActions();
  withActions([pull()], actions);
  fireEvent.click(screen.getByRole("button", { name: "Auto-merge" }));
  await finish(undefined, new Error("GitHub refused: Pull request is in unstable status."));
  expect(screen.getByRole("alert").textContent).toBe("GitHub refused: Pull request is in unstable status.");
  expect(screen.getByRole("alert").closest(".pull-actions")).toBeTruthy();
  // Nothing changed, and it can be tried again.
  expect(screen.queryByText("Auto-merge", { selector: ".badge" })).toBeNull();
  const button = screen.getByRole("button", { name: "Auto-merge" }) as HTMLButtonElement;
  expect(button.disabled).toBe(false);

  fireEvent.click(button);
  expect(screen.queryByRole("alert")).toBeNull();
  await finish(undefined, "not an Error");
  expect(screen.getByRole("alert").textContent).toBe("That didn't work.");
});
