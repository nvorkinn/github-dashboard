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
  ).toEqual([
    ["tag: Done"],
    ["build (amd64): Done", "build (arm64): FailedRe-run"],
    ["image: Skipped"],
    ["lost: CancelledRe-run"],
  ]);
  expect(
    within(stages[0] as HTMLElement)
      .getByRole("link", { name: "tag" })
      .getAttribute("href"),
  ).toBe("https://github.com/o/r/actions/runs/1/job/1");
  // A job the run never got to is drawn as skipped once the run has finished.
  expect(
    within(stages[2] as HTMLElement)
      .getByRole("listitem")
      .classList.contains("tone-skipped"),
  ).toBe(true);
  expect(container.querySelector(".graph-lines")?.getAttribute("aria-hidden")).toBe("true");

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

test("a big matrix is one card that opens into its jobs", () => {
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
  const group = container.querySelector(".job-group") as HTMLElement;
  expect(group.classList.contains("tone-failed")).toBe(true);
  expect(group.querySelector("summary")?.textContent).toBe("test: Failed,4/8 finished");
  expect(group.querySelectorAll("details .job")).toHaveLength(8);
  // Still going, so nothing to re-run.
  expect(screen.queryByRole("button")).toBeNull();
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
