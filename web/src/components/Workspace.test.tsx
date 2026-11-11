// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/preact";
import { afterEach, expect, test, vi } from "vitest";
import { ActionsContext } from "./actions.tsx";
import { DashboardView } from "./DashboardView.tsx";
import { fakeRunActions, NOW, project, pull, ready, run } from "./testing.ts";

const other = "octocat/home-ledger";
const data = () =>
  ready({
    projects: [project(), project({ repo: other, name: "home-ledger" })],
    pulls: [pull({ title: "Weather change" }), pull({ repo: other, number: 2, title: "Ledger change" })],
    releases: [
      run({ state: "running", finishedAt: undefined, title: "Weather deploy" }),
      run({ repo: other, id: 2, title: "Ledger deploy" }),
    ],
  });

function dashboard(state = data(), refresh = vi.fn()) {
  return render(<DashboardView state={state} now={NOW} refresh={refresh} view="workspace" />);
}

function select(name: string | RegExp) {
  fireEvent.click(within(screen.getByRole("navigation", { name: "Repositories" })).getByRole("button", { name }));
}

afterEach(() => {
  cleanup();
  localStorage.clear();
});

test("scopes both lists to the repository, retains scope in focused views, and returns to overview", () => {
  dashboard();
  expect(screen.getByText("Weather change")).toBeTruthy();
  expect(screen.getByText("Ledger change")).toBeTruthy();
  select(/weather-station/);
  expect(screen.queryByText("Ledger change")).toBeNull();
  expect(screen.queryByText("Ledger deploy")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Workflows" }));
  expect(screen.queryByText("Weather change")).toBeNull();
  expect(screen.getByText("Weather deploy")).toBeTruthy();
  expect(screen.getByRole("heading", { name: "weather-station" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: /Overview/ }));
  expect(screen.getByText("Ledger change")).toBeTruthy();
});

test("searches repository owners and names without changing the selected workspace", () => {
  dashboard();
  select(/weather-station/);
  fireEvent.input(screen.getByRole("searchbox"), { target: { value: "HOME-ledger" } });
  const nav = screen.getByRole("navigation", { name: "Repositories" });
  expect(within(nav).queryByRole("button", { name: /weather-station/ })).toBeNull();
  expect(within(nav).getByRole("button", { name: /home-ledger/ })).toBeTruthy();
  expect(screen.getByText("Weather change")).toBeTruthy();
  fireEvent.input(screen.getByRole("searchbox"), { target: { value: "missing" } });
  expect(screen.getByText("No matching repositories")).toBeTruthy();
});

test("hides the selected repository, returns to overview, and refreshes when showing it again", () => {
  const refresh = vi.fn();
  dashboard(data(), refresh);
  select(/weather-station/);
  fireEvent.click(screen.getByRole("button", { name: "Hide weather-station" }));
  expect(screen.getByRole("heading", { name: "Overview" })).toBeTruthy();
  expect(screen.queryByText("Weather change")).toBeNull();
  expect(screen.queryByText("Weather deploy")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Show weather-station" }));
  expect(refresh).toHaveBeenCalledOnce();
  expect(screen.getByText("Weather change")).toBeTruthy();
});

test("keeps repository release confirmations connected to the selected project", async () => {
  const actions = fakeRunActions();
  render(
    <ActionsContext.Provider value={{ runs: actions }}>
      <DashboardView state={data()} now={NOW} refresh={() => {}} view="workspace" />
    </ActionsContext.Provider>,
  );
  select(/weather-station/);
  const header = screen.getByRole("link", { name: "View on GitHub" }).parentElement;
  expect(header).toBeTruthy();
  fireEvent.click(within(header as HTMLElement).getByRole("button", { name: "Release weather-station" }));
  expect(await screen.findByText("Release v1.3.0?")).toBeTruthy();
  expect(actions.release).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
  expect(actions.release).toHaveBeenCalledWith(project(), "v1.3.0");
});

test("shows honest job inspection and log links, plus approval and failed workflow attention", () => {
  dashboard(
    ready({
      projects: [project()],
      releases: [
        run({
          state: "waiting",
          finishedAt: undefined,
          jobs: [
            {
              id: 1,
              name: "Deploy",
              state: "waiting",
              url: "https://github.com/octocat/weather-station/actions/runs/1/job/1",
              startedAt: undefined,
              finishedAt: undefined,
            },
          ],
          approvals: [{ environment: "production", environmentId: 1, canApprove: false }],
        }),
      ],
    }),
  );
  expect(screen.getByText("Job details & logs")).toBeTruthy();
  expect(screen.getByRole("link", { name: "Logs on GitHub for Deploy" }).getAttribute("target")).toBe("_blank");
  expect(screen.getByText("production waits for its required reviewers")).toBeTruthy();
  const summary = screen.getByRole("region", { name: "Dashboard summary" });
  expect(within(summary).getByText("NEEDS ATTENTION").nextElementSibling?.textContent).toBe("1");
});

test("handles no repositories and a removed selection without leaking stale context", () => {
  const view = dashboard();
  select(/weather-station/);
  view.rerender(<DashboardView state={ready()} now={NOW} refresh={() => {}} view="workspace" />);
  expect(screen.getByRole("heading", { name: "Overview" })).toBeTruthy();
  expect(screen.getByText("No open pull requests")).toBeTruthy();
  expect(screen.getByText("Nothing running")).toBeTruthy();
  expect(screen.getByText("No repositories")).toBeTruthy();
});
