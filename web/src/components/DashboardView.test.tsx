// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/preact";
import { afterEach, expect, test, vi } from "vitest";
import type { DashboardState } from "../model.ts";
import { DashboardView, Freshness, useRefresh } from "./DashboardView.tsx";
import { fakeDashboard, NOW, project, pull, ready, run } from "./testing.ts";

afterEach(cleanup);

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
  expect(screen.getAllByRole("heading").map((heading) => heading.textContent)).toEqual([
    "Open pull requests 1",
    "Release workflows 1",
    "Projects & releases 1",
  ]);
  expect(screen.queryByRole("alert")).toBeNull();
});

test("says what there is none of", () => {
  render(<DashboardView state={ready()} now={NOW} refresh={() => {}} />);
  expect(screen.getByText("No open pull requests")).toBeTruthy();
  expect(screen.getByText("No release runs")).toBeTruthy();
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

test("is read-only", () => {
  render(
    <DashboardView
      state={ready({ pulls: [pull()], releases: [run()], projects: [project()] })}
      now={NOW}
      refresh={() => {}}
    />,
  );
  expect(screen.queryByRole("button")).toBeNull();
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
