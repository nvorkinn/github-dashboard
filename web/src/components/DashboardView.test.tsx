// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/preact";
import { afterEach, expect, test, vi } from "vitest";
import type { DashboardState } from "../model.ts";
import { DashboardView, Freshness, useRefresh } from "./DashboardView.tsx";
import { HIDDEN_PROJECTS_KEY } from "./hooks.ts";
import { fakeDashboard, NOW, project, pull, ready, run } from "./testing.ts";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

test("says that it is loading", () => {
  render(<DashboardView state={{ status: "loading" }} now={NOW} refresh={() => {}} />);
  expect(screen.getByText("Loading your projects…")).toBeTruthy();
  expect(screen.queryByRole("heading")).toBeNull();
});

test("says why the read failed and offers another try", () => {
  const refresh = vi.fn();
  render(<DashboardView state={{ status: "failed", problem: "GitHub is down." }} now={NOW} refresh={refresh} />);
  expect(screen.getByRole("alert").textContent).toBe("GitHub is down.");
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  expect(refresh).toHaveBeenCalledOnce();
});

test("draws the three lists", () => {
  render(
    <DashboardView
      state={ready({ pulls: [pull()], releases: [run()], projects: [project()] })}
      now={NOW}
      refresh={() => {}}
    />,
  );
  expect(screen.getAllByRole("heading", { level: 2 }).map((heading) => heading.textContent)).toEqual([
    "Pull requests 1",
    "Running now 1",
    "Projects & releases 1",
  ]);
  expect(screen.queryByRole("alert")).toBeNull();
});

test("says what there is none of", () => {
  render(<DashboardView state={ready()} now={NOW} refresh={() => {}} />);
  expect(screen.getByText("No open pull requests")).toBeTruthy();
  expect(screen.getByText("Nothing running")).toBeTruthy();
  expect(screen.getByText("No projects")).toBeTruthy();
});

test("keeps the data up under a problem", () => {
  render(
    <DashboardView
      state={ready({ pulls: [pull({ title: "Still here" })] }, { problem: "GitHub didn't answer." })}
      now={NOW}
      refresh={() => {}}
    />,
  );
  expect(screen.getByRole("alert").textContent).toBe("GitHub didn't answer.");
  expect(screen.getByText("Still here")).toBeTruthy();
});

test("without actions it only shows, and lets a project be hidden", () => {
  render(
    <DashboardView
      state={ready({ pulls: [pull()], releases: [run()], projects: [project()] })}
      now={NOW}
      refresh={() => {}}
    />,
  );
  expect(screen.getAllByRole("button").map((button) => button.getAttribute("aria-label"))).toEqual([
    "Hide weather-station",
  ]);
});

test("a hidden project takes its pull requests and runs off the page, until it is shown again", () => {
  const ledger = "octocat/home-ledger";
  const state = ready({
    pulls: [pull({ title: "Stays" }), pull({ repo: ledger, number: 2, title: "Goes" })],
    releases: [run({ title: "v1.0.0" }), run({ repo: ledger, id: 2, title: "v9.9.9" })],
    projects: [project(), project({ repo: ledger, name: "home-ledger" })],
  });
  const view = render(<DashboardView state={state} now={NOW} refresh={() => {}} />);
  fireEvent.click(screen.getByRole("button", { name: "Hide home-ledger" }));
  expect(screen.queryByText("Goes")).toBeNull();
  expect(screen.queryByRole("link", { name: "v9.9.9" })).toBeNull();
  expect(screen.getByText("Stays")).toBeTruthy();
  expect(screen.getAllByRole("heading", { level: 2 }).map((heading) => heading.textContent)).toEqual([
    "Pull requests 1",
    "Running now 1",
    "Projects & releases 1",
  ]);
  expect(screen.getByText("1 more in hidden projects")).toBeTruthy();
  expect(JSON.parse(localStorage.getItem(HIDDEN_PROJECTS_KEY) ?? "")).toEqual([ledger]);

  // The browser remembers it for the next visit.
  view.unmount();
  render(<DashboardView state={state} now={NOW} refresh={() => {}} />);
  expect(screen.queryByText("Goes")).toBeNull();

  fireEvent.click(screen.getByRole("button", { name: "Show home-ledger" }));
  expect(screen.getByText("Goes")).toBeTruthy();
  expect(screen.getByRole("link", { name: "v9.9.9" })).toBeTruthy();
  expect(JSON.parse(localStorage.getItem(HIDDEN_PROJECTS_KEY) ?? "")).toEqual([]);
});

test("what is kept under the key but is no list of names hides nothing", () => {
  localStorage.setItem(HIDDEN_PROJECTS_KEY, "{not json");
  render(<DashboardView state={ready({ projects: [project()] })} now={NOW} refresh={() => {}} />);
  expect(screen.getByRole("link", { name: "weather-station" })).toBeTruthy();
});

function freshness(state: DashboardState, pending = false) {
  const refresh = vi.fn();
  render(<Freshness state={state} now={NOW} refresh={refresh} pending={pending} />);
  return refresh;
}

test("says how fresh the data is and refreshes on request", () => {
  const refresh = freshness(ready());
  expect(screen.getByText("12s ago")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
  expect(refresh).toHaveBeenCalledOnce();
});

test("says whether changes arrive as they happen, and what happens while they don't", () => {
  freshness(ready());
  expect(screen.getByText("Live").title).toBe("Changes on GitHub show here as they happen.");
  expect(screen.queryByText("Reconnecting")).toBeNull();
  cleanup();

  freshness(ready({}, { live: false }));
  expect(screen.getByText("Reconnecting").title).toBe(
    "Not connected for live updates. Checking GitHub every minute meanwhile.",
  );
  expect(screen.queryByText("Live")).toBeNull();
  // Still says how old the data is.
  expect(screen.getByText("12s ago")).toBeTruthy();
  cleanup();

  // Nothing to say before there is anything to keep fresh.
  freshness({ status: "loading" });
  expect(screen.queryByText(/Live|Reconnecting/)).toBeNull();
});

test("shows a refresh under way, whoever started it", () => {
  freshness(ready({}, { refreshing: true }));
  expect((screen.getByRole("button", { name: "Refreshing…" }) as HTMLButtonElement).disabled).toBe(true);
  cleanup();
  freshness(ready(), true);
  expect((screen.getByRole("button", { name: "Refreshing…" }) as HTMLButtonElement).disabled).toBe(true);
});

test("can't refresh before the first read, but can after a failed one", () => {
  freshness({ status: "loading" });
  expect((screen.getByRole("button", { name: "Refresh" }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.queryByText(/updated/)).toBeNull();
  cleanup();
  freshness({ status: "failed", problem: "No." });
  expect((screen.getByRole("button", { name: "Refresh" }) as HTMLButtonElement).disabled).toBe(false);
});

test("a refresh is pending until the dashboard is done with it, also when it fails", async () => {
  const dashboard = fakeDashboard(ready());
  let fail = () => {};
  dashboard.refresh.mockImplementation(
    () =>
      new Promise<void>((_, reject) => {
        fail = () => reject(new Error("network"));
      }),
  );
  function Button() {
    const { refresh, pending } = useRefresh(dashboard);
    return (
      <button type="button" onClick={refresh}>
        {pending ? "pending" : "idle"}
      </button>
    );
  }
  render(<Button />);
  fireEvent.click(screen.getByRole("button", { name: "idle" }));
  expect(await screen.findByRole("button", { name: "pending" })).toBeTruthy();
  fail();
  expect(await screen.findByRole("button", { name: "idle" })).toBeTruthy();
});
