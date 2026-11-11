// @vitest-environment happy-dom
import { cleanup, render, screen, within } from "@testing-library/preact";
import { afterEach, expect, test } from "vitest";
import type { Job } from "../model.ts";
import { ReleaseList, sortRuns } from "./ReleaseList.tsx";
import { before, NOW, run } from "./testing.ts";

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

test("says so when there are none, and explains the colours", () => {
  render(<ReleaseList runs={[]} now={NOW} />);
  expect(screen.getByText("No release runs")).toBeTruthy();
  const legend = screen.getByRole("list", { name: "Legend" });
  expect(
    within(legend)
      .getAllByRole("listitem")
      .map((item) => item.textContent),
  ).toEqual(["Done", "Running", "Waiting for approval", "Not started", "Failed", "Skipped"]);
});

test("draws a finished run", () => {
  const { container } = render(
    <ReleaseList
      now={NOW}
      runs={[run({ title: "v2.4.1", startedAt: before(3_600_000), finishedAt: before(3_600_000 - 252_000) })]}
    />,
  );
  const card = container.querySelector(".release") as HTMLElement;
  expect(card.querySelector(".repo-label")?.textContent).toBe("weather-station · Release");
  expect(within(card).getByRole("link", { name: "v2.4.1" }).getAttribute("href")).toBe(
    "https://github.com/octocat/weather-station/actions/runs/1",
  );
  expect(card.textContent).toContain("started by octocat");
  expect(card.textContent).toContain("1h ago");
  expect(card.textContent).toContain("took 4m 12s");
  expect(card.querySelector(".chip")?.textContent).toBe("Done");
  expect(card.querySelector(".chip")?.classList.contains("tone-done")).toBe(true);
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
    "deploy dev: Running1m 5s",
    "approve-prod: Waiting for approval",
    "deploy prod: Not started",
    "notify: Skipped",
    "sign: Failed10s",
  ]);
  expect(jobs.map((item) => item.className)).toEqual([
    "job tone-done",
    "job tone-running",
    "job tone-waiting",
    "job tone-queued",
    "job tone-skipped",
    "job tone-failed",
  ]);
  expect(within(card).getByRole("link", { name: "build" }).getAttribute("href")).toBe("https://x/1");
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
  expect(screen.getByRole("heading").textContent).toBe("Release workflows 3");
});
