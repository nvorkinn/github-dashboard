// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/preact";
import { afterEach, expect, test } from "vitest";
import type { Approval, Job, ReleaseRun } from "../model.ts";
import { ActionsContext } from "./actions.tsx";
import { KEEP_FINISHED_MS, ReleaseList, shownRuns, sortRuns } from "./ReleaseList.tsx";
import { before, fakeRunActions, NOW, run } from "./testing.ts";

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

test("says so when nothing runs, and has no legend", () => {
  render(<ReleaseList runs={[]} now={NOW} />);
  expect(screen.getByText("Nothing running")).toBeTruthy();
  expect(screen.queryByRole("list")).toBeNull();
});

test("folds a run that just finished, with its jobs behind Jobs, and counts down to when it leaves", () => {
  const { container } = render(
    <ReleaseList
      now={NOW}
      runs={[
        run({
          title: "v2.4.1",
          startedAt: before(360_000),
          finishedAt: before(108_000),
          jobs: [job({ id: 1, name: "build" })],
        }),
      ]}
    />,
  );
  const card = container.querySelector(".release") as HTMLElement;
  expect(card.classList.contains("release-folded")).toBe(true);
  expect(card.querySelector(".repo-label")?.textContent).toBe("weather-station · Release");
  expect(within(card).getByRole("link", { name: "v2.4.1" }).getAttribute("href")).toBe(
    "https://github.com/octocat/weather-station/actions/runs/1",
  );
  expect(card.querySelector(".chip")?.textContent).toBe("Done");
  expect(card.querySelector(".meta")?.textContent).toBe("took 4m 12sleaves in 3:12");
  const bar = card.querySelector("progress") as HTMLProgressElement;
  expect([bar.value, bar.max]).toEqual([192_000, KEEP_FINISHED_MS]);
  const jobs = card.querySelector("details") as HTMLDetailsElement;
  expect(jobs.open).toBe(false);
  expect(jobs.querySelector("summary")?.textContent).toBe("Jobs");
  expect(jobs.querySelector(".job")?.textContent).toBe("build: Done");
});

test("shows runs still going and those that finished within five minutes, failed ones too", () => {
  const runs = [
    run({ id: 1, state: "running", startedAt: before(7_200_000), finishedAt: undefined }),
    run({ id: 2, state: "waiting", finishedAt: undefined }),
    run({ id: 3, state: "queued", finishedAt: undefined }),
    run({ id: 4, state: "passed", finishedAt: before(KEEP_FINISHED_MS - 1000) }),
    run({ id: 5, state: "failed", finishedAt: before(KEEP_FINISHED_MS - 1000) }),
    run({ id: 6, state: "passed", finishedAt: before(KEEP_FINISHED_MS) }),
    run({ id: 7, state: "failed", finishedAt: before(3_600_000) }),
  ];
  expect(shownRuns(runs, NOW).map((one) => one.id)).toEqual([1, 2, 3, 4, 5]);
  // A second later the two that were about to leave have left.
  expect(shownRuns(runs, NOW + 1000).map((one) => one.id)).toEqual([1, 2, 3]);

  render(<ReleaseList now={NOW} runs={runs} />);
  expect(screen.getByRole("heading").textContent).toBe("Running now 5");
});

test("draws a run under way with its jobs", () => {
  const { container } = render(
    <ReleaseList
      now={NOW}
      runs={[
        run({
          state: "running",
          actor: undefined,
          startedAt: before(200_000),
          finishedAt: undefined,
          jobs: [
            job({ id: 1, name: "build", startedAt: before(200_000), finishedAt: before(110_000), url: "https://x/1" }),
            job({ id: 2, name: "deploy dev", state: "running", startedAt: before(65_000) }),
            job({ id: 3, name: "approve-prod", state: "waiting" }),
            job({ id: 4, name: "deploy prod", state: "queued" }),
            job({ id: 5, name: "notify", state: "skipped" }),
            job({ id: 6, name: "sign", state: "failed", startedAt: before(30_000), finishedAt: before(20_000) }),
          ],
        }),
      ]}
    />,
  );
  const card = container.querySelector(".release") as HTMLElement;
  expect(card.querySelector(".chip")?.textContent).toBe("Running");
  expect(card.textContent).toContain("going for 3m 20s");
  expect(card.textContent).not.toContain("started by");

  const jobs = within(within(card).getByRole("list", { name: "Jobs" })).getAllByRole("listitem");
  // The state is in words too, not only in the colour and the shape.
  expect(jobs.map((item) => item.textContent)).toEqual([
    "build: Done1m 30s",
    "deploy dev: Running · 1m 5s",
    "approve-prod: Waiting for approval",
    "deploy prod: Not started",
    "notify: Skipped",
    "sign: Failed10s",
  ]);
  expect(jobs.map((item) => item.className)).toEqual([
    "job tone-done job-tick",
    "job tone-running job-live",
    "job tone-waiting job-live",
    "job tone-queued",
    "job tone-skipped job-tick",
    "job tone-failed",
  ]);
  fireEvent.click(within(card).getByRole("button", { name: "Inspect build" }));
  expect(within(card).getByRole("link", { name: "Open logs for build on GitHub" }).getAttribute("href")).toBe(
    "https://x/1",
  );
});

test("puts runs still going first, then the newest", () => {
  const sorted = sortRuns([
    run({ id: 1, startedAt: before(1000) }),
    run({ id: 2, state: "failed", startedAt: before(500) }),
    run({ id: 3, state: "waiting", startedAt: before(9000), finishedAt: undefined }),
    run({ id: 4, state: "running", startedAt: before(8000), finishedAt: undefined }),
  ]);
  expect(sorted.map((one) => one.id)).toEqual([4, 3, 2, 1]);
});

test("stacks the cards in one list", () => {
  const { container } = render(<ReleaseList now={NOW} runs={[run({ id: 1 }), run({ id: 2 }), run({ id: 3 })]} />);
  expect(container.querySelectorAll("ul.rows > li.release")).toHaveLength(3);
  expect(screen.getByRole("heading").textContent).toBe("Running now 3");
});

function withActions(runs: ReleaseRun[], actions = fakeRunActions()) {
  const view = render(
    <ActionsContext.Provider value={{ runs: actions }}>
      <ReleaseList now={NOW} runs={runs} />
    </ActionsContext.Provider>,
  );
  return { ...view, actions };
}

const production: Approval = { environmentId: 70, environment: "production", canApprove: true };

test("a waiting run offers Approve and Reject for each environment its user may approve, each asking first", async () => {
  const waiting = run({
    state: "waiting",
    finishedAt: undefined,
    jobs: [job({ id: 1, name: "approve-prod", state: "waiting" })],
    approvals: [production, { environmentId: 71, environment: "billing", canApprove: false }],
  });
  const { actions } = withActions([waiting]);
  expect(screen.getByText("billing waits for its required reviewers")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Approve billing" })).toBeNull();

  fireEvent.click(screen.getByRole("button", { name: "Approve production" }));
  expect(screen.getByText("Approve production?")).toBeTruthy();
  expect(actions.review).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
  expect(actions.review).toHaveBeenCalledWith(waiting, production, "approved");
  expect((await screen.findByRole("status")).textContent).toBe("Approved production.");

  fireEvent.click(screen.getByRole("button", { name: "Reject production" }));
  expect(screen.getByText("Reject production?")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
  expect(actions.review).toHaveBeenLastCalledWith(waiting, production, "rejected");
});

test("a finished run that failed offers to re-run its failed jobs, and each failed or cancelled job alone", async () => {
  const failed = run({
    state: "failed",
    jobs: [
      job({ id: 1, name: "build", state: "passed" }),
      job({ id: 2, name: "sign", state: "failed" }),
      job({ id: 3, name: "notify", state: "cancelled" }),
      job({ id: 4, name: "publish", state: "skipped" }),
    ],
  });
  const actions = fakeRunActions();
  actions.rerunJob.mockRejectedValueOnce(new Error("Only a failed or cancelled job can be re-run."));
  withActions([failed], actions);
  expect(screen.getByRole("button", { name: "Inspect sign" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Inspect notify" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Re-run sign" })).toBeNull();

  fireEvent.click(screen.getByRole("button", { name: "Re-run failed jobs" }));
  expect(actions.rerunFailed).toHaveBeenCalledWith(failed);
  expect((await screen.findByRole("status")).textContent).toBe("Re-run of the failed jobs started.");

  fireEvent.click(screen.getByRole("button", { name: "Inspect sign" }));
  fireEvent.click(screen.getByRole("button", { name: "Re-run sign" }));
  expect(actions.rerunJob).toHaveBeenCalledWith(failed, failed.jobs[1]);
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toBe("Only a failed or cancelled job can be re-run.");
  expect(alert.closest(".job")).toBeNull();
});

test("a run still going, or one that passed, offers no re-run", () => {
  withActions([
    run({ id: 1, state: "running", finishedAt: undefined, jobs: [job({ id: 1, state: "failed" })] }),
    run({ id: 2, state: "passed", jobs: [job({ id: 2, state: "passed" })] }),
  ]);
  expect(screen.queryByRole("button", { name: /^Re-run/ })).toBeNull();
});

test("without actions the cards only show", () => {
  render(
    <ReleaseList
      now={NOW}
      runs={[
        run({ state: "waiting", finishedAt: undefined, approvals: [production] }),
        run({ id: 2, state: "failed" }),
      ]}
    />,
  );
  expect(screen.queryByRole("button")).toBeNull();
  expect(screen.getByText("production waits for its required reviewers")).toBeTruthy();
});

test("a run that says which release it is shows its tag, folded too", () => {
  const { container } = render(
    <ReleaseList
      now={NOW}
      runs={[
        run({ id: 1, title: "Fix the wind direction (#207)", tag: "v2.4.1" }),
        run({ id: 2, title: "Release", tag: undefined, state: "running", finishedAt: undefined }),
      ]}
    />,
  );
  const [going, folded] = [...container.querySelectorAll(".release")] as HTMLElement[];
  expect(folded?.classList.contains("release-folded")).toBe(true);
  expect(folded?.querySelector(".release-tag")?.textContent).toBe("v2.4.1");
  expect(going?.querySelector(".release-tag")).toBeNull();
});
