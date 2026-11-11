// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/preact";
import { afterEach, expect, test, vi } from "vitest";
import type { Job, ReleaseRun } from "../model.ts";
import { ActionsContext } from "./actions.tsx";
import { ReleaseList } from "./ReleaseList.tsx";
import { fakeRunActions, NOW, run } from "./testing.ts";

afterEach(cleanup);

const job = (fields: Partial<Job>): Job => ({
  id: 1,
  name: "build",
  state: "passed",
  url: undefined,
  startedAt: undefined,
  finishedAt: undefined,
  ...fields,
});

function withActions(runs: ReleaseRun[], actions = fakeRunActions()) {
  const view = render(
    <ActionsContext.Provider value={{ runs: actions }}>
      <ReleaseList now={NOW} runs={runs} />
    </ActionsContext.Provider>,
  );
  return { ...view, actions };
}

test("draws the jobs on the workflow's graph, in stages, keeping their re-runs", async () => {
  const tag = job({ id: 1, name: "tag", url: "https://github.com/o/r/actions/runs/1/job/1" });
  const builds = [job({ id: 2, name: "build (amd64)" }), job({ id: 3, name: "build (arm64)", state: "failed" })];
  const lost = job({ id: 4, name: "lost", state: "cancelled" });
  const failed = run({
    state: "failed",
    jobs: [tag, ...builds, lost],
    graph: {
      nodes: [
        { key: "tag", name: "tag", needs: [], several: false, jobs: [tag] },
        { key: "build", name: "build", needs: ["tag"], several: true, jobs: builds },
        { key: "image", name: "image", needs: ["build"], several: false, jobs: [] },
      ],
      unplaced: [lost],
    },
  });
  const { container, actions } = withActions([failed]);
  const stages = screen.getAllByRole("list", { name: /^Stage / });
  expect(
    stages.map((stage) =>
      within(stage)
        .getAllByRole("listitem")
        .map((item) => item.textContent),
    ),
  ).toEqual([["tag: Done"], ["build (amd64): Done", "build (arm64): Failed"], ["image: Skipped"], ["lost: Cancelled"]]);
  const inspectTag = within(stages[0] as HTMLElement).getByRole("button", { name: "Inspect tag" });
  expect(inspectTag.getAttribute("aria-expanded")).toBe("false");
  fireEvent.click(inspectTag);
  expect(inspectTag.getAttribute("aria-expanded")).toBe("true");
  const details = screen.getByRole("region", { name: "Job details: tag" });
  expect(within(details).getByText("Done")).toBeTruthy();
  expect(within(details).getByRole("link", { name: "Open logs for tag on GitHub" }).getAttribute("href")).toBe(
    "https://github.com/o/r/actions/runs/1/job/1",
  );
  // A job the run never got to is drawn as skipped once the run has finished.
  expect(
    within(stages[2] as HTMLElement)
      .getByRole("listitem")
      .classList.contains("tone-skipped"),
  ).toBe(true);
  expect(container.querySelector(".graph-lines")?.getAttribute("aria-hidden")).toBe("true");

  fireEvent.click(screen.getByRole("button", { name: "Inspect build (arm64)" }));
  fireEvent.click(screen.getByRole("button", { name: "Re-run build (arm64)" }));
  expect(actions.rerunJob).toHaveBeenCalledWith(failed, builds[1]);
  expect((await screen.findByRole("status")).textContent).toBe("Re-run of build (arm64) started.");
});

test("a job of the file not started yet is drawn as not started while the run goes on", () => {
  render(
    <ReleaseList
      now={NOW}
      runs={[
        run({
          state: "running",
          finishedAt: undefined,
          graph: { nodes: [{ key: "a", name: "a", needs: [], several: false, jobs: [] }], unplaced: [] },
        }),
      ]}
    />,
  );
  const chip = within(screen.getByRole("list", { name: "Stage 1" })).getByRole("listitem");
  expect(chip.textContent).toBe("a: Not started");
  expect(chip.classList.contains("tone-queued")).toBe(true);
});

test("a big matrix is one box with a grid of its jobs, and the graph runs top to bottom", () => {
  const jobs = Array.from({ length: 8 }, (_, n) =>
    job({ id: n + 1, name: `test (${n})`, state: n < 3 ? "passed" : n === 3 ? "failed" : "queued" }),
  );
  const { container } = withActions([
    run({
      state: "running",
      finishedAt: undefined,
      jobs,
      graph: { nodes: [{ key: "test", name: "test", needs: [], several: true, jobs }], unplaced: [] },
    }),
  ]);
  expect(container.querySelector(".graph")?.classList.contains("graph-stack")).toBe(true);
  const group = container.querySelector(".job-matrix") as HTMLElement;
  expect(group.classList.contains("tone-failed")).toBe(true);
  expect(group.querySelector(".job-matrix-head")?.textContent).toBe("test: Failed,4 of 8 done");
  const cells = [...group.querySelectorAll<HTMLElement>(".job-grid .job")];
  expect(cells).toHaveLength(8);
  // Only what tells the cells apart shows; screen readers still get the whole name.
  expect(cells[0]?.textContent).toBe("test (0): Done");
  expect(cells[0]?.querySelector(".visually-hidden")?.textContent).toBe("test (");
  // Still going, so inspection is available but no re-run action is.
  expect(screen.getAllByRole("button", { name: /^Inspect test/ })).toHaveLength(8);
  expect(screen.queryByRole("button", { name: /^Re-run/ })).toBeNull();
});

test("finished jobs shrink to ticks and the running one says what it is doing", () => {
  const done = job({ id: 1, name: "build", startedAt: "2026-01-01T00:00:00Z", finishedAt: "2026-01-01T00:01:00Z" });
  const live = job({ id: 2, name: "deploy", state: "running", startedAt: new Date(NOW - 21_000).toISOString() });
  const waiting = job({ id: 3, name: "approve", state: "waiting" });
  const { container } = render(
    <ReleaseList
      now={NOW}
      runs={[
        run({
          state: "running",
          finishedAt: undefined,
          jobs: [done, live, waiting],
          graph: {
            nodes: [
              { key: "build", name: "build", needs: [], several: false, jobs: [done] },
              { key: "deploy", name: "deploy", needs: ["build"], several: false, jobs: [live] },
              { key: "approve", name: "approve", needs: ["deploy"], several: false, jobs: [waiting] },
            ],
            unplaced: [],
          },
        }),
      ]}
    />,
  );
  const [first, second, third] = [...container.querySelectorAll<HTMLElement>(".graph .job")];
  expect(first?.classList.contains("job-tick")).toBe(true);
  expect(second?.classList.contains("job-live")).toBe(true);
  expect(second?.querySelector(".job-state")?.textContent).toBe(": Running · 21s");
  expect(third?.classList.contains("job-live")).toBe(true);
  expect(third?.textContent).toBe("approve: Waiting for approval");
});

test("draws a line from each job to those that wait for it, where they turned out to be", () => {
  const a = job({ id: 1, name: "a" });
  const b = job({ id: 2, name: "b" });
  const spy = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const card = this.dataset.card;
    const x = card === "node-b" ? 150 : 0;
    const width = card ? 100 : 250;
    return { left: x, right: x + width, top: 0, bottom: 20, width, height: 20, x, y: 0, toJSON: () => ({}) };
  });
  try {
    const { container } = render(
      <ReleaseList
        now={NOW}
        runs={[
          run({
            jobs: [a, b],
            graph: {
              nodes: [
                { key: "a", name: "a", needs: [], several: false, jobs: [a] },
                { key: "b", name: "b", needs: ["a"], several: false, jobs: [b] },
              ],
              unplaced: [],
            },
          }),
        ]}
      />,
    );
    expect([...container.querySelectorAll(".graph-lines path")].map((path) => path.getAttribute("d"))).toEqual([
      "M100,10 C125,10 125,10 150,10",
    ]);
  } finally {
    spy.mockRestore();
  }
});

test("shows the jobs in a row when the workflow file couldn't be read", () => {
  render(<ReleaseList now={NOW} runs={[run({ jobs: [job({ id: 1, name: "build" })], graph: undefined })]} />);
  expect(screen.queryByRole("list", { name: /^Stage / })).toBeNull();
  expect(within(screen.getByRole("list", { name: "Jobs" })).getByRole("listitem").textContent).toBe("build: Done");
});

test("shows available timing and log metadata in the selected job detail pane", () => {
  const build = job({
    name: "build",
    url: "https://github.com/o/r/actions/runs/1/job/1",
    startedAt: "2026-03-01T11:58:00Z",
    finishedAt: "2026-03-01T11:59:00Z",
  });
  render(<ReleaseList now={NOW} runs={[run({ jobs: [build], graph: undefined })]} />);

  fireEvent.click(screen.getByRole("button", { name: "Inspect build" }));
  const details = screen.getByRole("region", { name: "Job details: build" });
  expect(within(details).getByText("1m 0s")).toBeTruthy();
  expect(within(details).getByRole("link", { name: "Open logs for build on GitHub" }).getAttribute("target")).toBe(
    "_blank",
  );
  expect(details.querySelector("time")?.getAttribute("datetime")).toBe(build.startedAt);

  fireEvent.click(within(details).getByRole("button", { name: "Close details for build" }));
  expect(screen.queryByRole("region", { name: "Job details: build" })).toBeNull();
});
