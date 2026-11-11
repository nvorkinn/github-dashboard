// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/preact";
import { afterEach, expect, test, vi } from "vitest";
import { ActionsContext } from "./actions.tsx";
import { DashboardView } from "./DashboardView.tsx";
import { fakeRunActions, NOW, project, pull, ready, run } from "./testing.ts";
import { navigateWorkspace, Workspace } from "./Workspace.tsx";

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
  fireEvent.click(
    within(screen.getByRole("complementary", { name: "Repository navigation" })).getByRole("button", {
      name: /Overview/,
    }),
  );
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
  const header = screen.getByRole("link", { name: "Open on GitHub" }).parentElement;
  expect(header).toBeTruthy();
  fireEvent.click(within(header as HTMLElement).getByRole("button", { name: /Release .*weather-station/ }));
  expect(await screen.findByText("Release octocat/weather-station as v1.3.0 from its default branch?")).toBeTruthy();
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

test("focuses the attention view on blocked pull requests and workflows", () => {
  dashboard(
    ready({
      projects: [project()],
      pulls: [
        pull({ number: 1, title: "Ready change", checks: [{ name: "test", state: "passed", url: undefined }] }),
        pull({ number: 2, title: "Broken change", mergeState: "conflicts" }),
      ],
      releases: [
        run({ id: 1, title: "Previous deploy" }),
        run({ id: 2, title: "Approval deploy", state: "waiting", finishedAt: undefined }),
      ],
    }),
  );

  fireEvent.click(screen.getByRole("button", { name: "Needs attention" }));
  expect(screen.getByText("Broken change")).toBeTruthy();
  expect(screen.getByText("Approval deploy")).toBeTruthy();
  expect(screen.queryByText("Ready change")).toBeNull();
  expect(screen.queryByText("Previous deploy")).toBeNull();
});

test("uses summary metrics to open focused operational views", () => {
  dashboard(
    ready({
      projects: [project()],
      pulls: [
        pull({ number: 1, title: "Ready change", checks: [{ name: "test", state: "passed", url: undefined }] }),
        pull({ number: 2, title: "Broken change", mergeState: "conflicts" }),
      ],
      releases: [run({ title: "Active deploy", state: "running", finishedAt: undefined })],
    }),
  );

  fireEvent.click(screen.getByRole("button", { name: "Show 1 pull requests ready to merge" }));
  expect(screen.getByText("Ready change")).toBeTruthy();
  expect(screen.queryByText("Broken change")).toBeNull();

  fireEvent.click(screen.getByRole("button", { name: "Show 1 items needing attention" }));
  expect(screen.getByText("Broken change")).toBeTruthy();
  expect(screen.queryByText("Ready change")).toBeNull();

  fireEvent.click(screen.getByRole("button", { name: "Show 1 active workflows" }));
  expect(screen.getByText("Active deploy")).toBeTruthy();
  expect(screen.queryByText("Broken change")).toBeNull();

  fireEvent.click(screen.getByRole("button", { name: "Show 2 open pull requests" }));
  expect(screen.getByText("Ready change")).toBeTruthy();
  expect(screen.getByText("Broken change")).toBeTruthy();
});

test("keeps the overview concise and exposes the complete workflow view", () => {
  dashboard(
    ready({
      projects: [project()],
      releases: [
        run({ id: 1, title: "First deploy", state: "running", finishedAt: undefined }),
        run({ id: 2, title: "Second deploy", state: "waiting", finishedAt: undefined }),
        run({ id: 3, title: "Third deploy", state: "queued", finishedAt: undefined }),
      ],
    }),
  );

  expect(screen.queryByText("First deploy")).toBeNull();
  expect(screen.queryByText("Second deploy")).toBeNull();
  expect(screen.getByText("Third deploy")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "View all 3 workflows" }));
  expect(screen.getByText("First deploy")).toBeTruthy();
});

test("accepts repository and section navigation from application commands", () => {
  dashboard();

  act(() => navigateWorkspace({ repo: other }));
  expect(screen.getByRole("heading", { name: "home-ledger" })).toBeTruthy();
  expect(screen.getByText("Ledger change")).toBeTruthy();
  expect(screen.queryByText("Weather change")).toBeNull();
  expect(screen.getByRole("button", { name: "Overview" }).getAttribute("aria-pressed")).toBe("true");

  act(() => navigateWorkspace({ section: "workflows" }));
  expect(screen.getByText("Ledger deploy")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Workflows" }).getAttribute("aria-pressed")).toBe("true");

  act(() => navigateWorkspace({ section: "releases" }));
  expect(screen.getByRole("button", { name: "Releases" }).getAttribute("aria-pressed")).toBe("true");

  act(() => navigateWorkspace({ repo: null }));
  expect(screen.getByRole("heading", { name: "Overview" })).toBeTruthy();
  expect(screen.getByText("Weather change")).toBeTruthy();
  expect(screen.getByText("Ledger change")).toBeTruthy();
});

test("ignores command navigation to unknown or hidden repositories", () => {
  render(
    <Workspace
      projects={data().data.projects}
      pulls={data().data.pulls}
      runs={data().data.releases}
      now={NOW}
      hidden={new Set([other])}
      onToggle={() => {}}
    />,
  );
  select(/weather-station/);

  act(() => navigateWorkspace({ repo: other }));
  expect(screen.getByRole("heading", { name: "weather-station" })).toBeTruthy();
  act(() => navigateWorkspace({ repo: "octocat/missing" }));
  expect(screen.getByRole("heading", { name: "weather-station" })).toBeTruthy();
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
