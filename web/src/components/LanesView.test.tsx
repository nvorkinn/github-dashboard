// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/preact";
import { afterEach, expect, test } from "vitest";
import { DashboardView } from "./DashboardView.tsx";
import { HIDDEN_PROJECTS_KEY } from "./hooks.ts";
import { NOW, project, pull, ready, run } from "./testing.ts";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

const LEDGER = "octocat/home-ledger";
const BOX = "octocat/recipe-box";

const STATE = ready({
  projects: [
    project(),
    project({ repo: LEDGER, name: "home-ledger", private: true }),
    project({ repo: BOX, name: "recipe-box" }),
  ],
  pulls: [
    pull({ number: 1, title: "Gusts" }),
    pull({ repo: LEDGER, number: 2, title: "Split" }),
    pull({ repo: LEDGER, number: 3, title: "Import" }),
  ],
  releases: [run({ state: "running", finishedAt: undefined, title: "v2.5.0" })],
});

function lanes() {
  return render(<DashboardView state={STATE} now={NOW} refresh={() => {}} view="lanes" />);
}

const lane = (name: string) => screen.getByRole("region", { name });

test("gives each project a lane, by name, holding its own runs and pull requests", () => {
  lanes();
  expect(screen.getAllByRole("heading", { level: 2 }).map((heading) => heading.textContent)).toEqual([
    "home-ledger",
    "recipe-box",
    "weather-station",
  ]);
  const station = lane("weather-station");
  expect(within(station).getByRole("link", { name: "v2.5.0" })).toBeTruthy();
  expect(within(station).getByText("Gusts")).toBeTruthy();
  expect(within(station).queryByText("Split")).toBeNull();

  const ledger = lane("home-ledger");
  expect(within(ledger).getByText("Nothing running")).toBeTruthy();
  expect(within(ledger).getByRole("heading", { level: 3 }).textContent).toBe("Pull requests 2");
  expect(within(ledger).getByText("Private")).toBeTruthy();
});

test("a project with nothing going on shrinks to one thin lane", () => {
  lanes();
  const box = lane("recipe-box");
  expect(box.classList.contains("lane-quiet")).toBe(true);
  expect(within(box).getByText("Nothing running, no open pull requests")).toBeTruthy();
  expect(lane("home-ledger").classList.contains("lane-quiet")).toBe(false);
});

test("hiding a project moves it to the dock, which brings it back", () => {
  lanes();
  fireEvent.click(screen.getByRole("button", { name: "Hide home-ledger" }));
  expect(screen.queryByRole("region", { name: "home-ledger" })).toBeNull();
  expect(screen.queryByText("Split")).toBeNull();
  const dock = screen.getByRole("region", { name: "Hidden 1" });
  expect(within(dock).getByRole("button", { name: "Show home-ledger" }).textContent).toBe("home-ledger");
  expect(JSON.parse(localStorage.getItem(HIDDEN_PROJECTS_KEY) ?? "")).toEqual([LEDGER]);

  fireEvent.click(within(dock).getByRole("button", { name: "Show home-ledger" }));
  expect(lane("home-ledger")).toBeTruthy();
  expect(screen.queryByRole("region", { name: /Hidden/ })).toBeNull();
});

test("says so when every project is hidden", () => {
  localStorage.setItem(HIDDEN_PROJECTS_KEY, JSON.stringify([LEDGER, BOX, "octocat/weather-station"]));
  lanes();
  expect(screen.getByText("Every project is hidden")).toBeTruthy();
  expect(screen.getByRole("region", { name: "Hidden 3" })).toBeTruthy();
});

test("marks the lanes as one column when that is chosen, and not otherwise", () => {
  const two = lanes();
  expect(two.container.querySelector(".lanes")?.className).toBe("lanes");
  two.unmount();
  const one = render(<DashboardView state={STATE} now={NOW} refresh={() => {}} view="lanes" laneColumns={1} />);
  expect(one.container.querySelector(".lanes")?.className).toBe("lanes lanes-single");
});
