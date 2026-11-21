// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/preact";
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
  return render(<DashboardView state={state} now={NOW} refresh={refresh} />);
}

function select(name: string | RegExp) {
  // The repository's own button, not its release controls, whose name also mentions it.
  const named = typeof name === "string" ? name : new RegExp(`^${name.source}`, name.flags);
  fireEvent.click(
    within(screen.getByRole("navigation", { name: "Repositories" })).getByRole("button", { name: named }),
  );
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
  expect(within(nav).getByRole("button", { name: /^home-ledger/ })).toBeTruthy();
  expect(screen.getByText("Weather change")).toBeTruthy();
  fireEvent.input(screen.getByRole("searchbox"), { target: { value: "missing" } });
  expect(screen.getByText("No matching repositories")).toBeTruthy();
});

test("hides the selected repository, returns to overview, and refreshes when showing it again", () => {
  const refresh = vi.fn();
  dashboard(data(), refresh);
  select(/weather-station/);
  fireEvent.click(screen.getByRole("button", { name: "Hide weather-station" }));
  expectOverview();
  const shownPulls = screen.getByRole("region", { name: /Open pull requests/ });
  expect(within(shownPulls).queryByText("Weather change")).toBeNull();
  expect(screen.queryByText("Weather deploy")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Show weather-station" }));
  expect(refresh).toHaveBeenCalledOnce();
  expect(screen.getByText("Weather change")).toBeTruthy();
});

test("releases the selected project from its header", async () => {
  const actions = fakeRunActions();
  render(
    <ActionsContext.Provider value={{ runs: actions }}>
      <DashboardView state={data()} now={NOW} refresh={() => {}} />
    </ActionsContext.Provider>,
  );
  select(/weather-station/);
  const header = screen.getByRole("link", { name: "Open on GitHub" }).parentElement;
  expect(header).toBeTruthy();
  fireEvent.click(within(header as HTMLElement).getByRole("button", { name: /Release .*weather-station/ }));
  await waitFor(() => expect(actions.release).toHaveBeenCalledWith(project(), "v1.3.0"));
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
  const sections = screen.getByRole("navigation", { name: "Workspace sections" });
  expect(within(sections).getByRole("button", { name: "Needs attention" }).textContent).toContain("1");
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

test("shows no page header or summary cards on the overview", () => {
  dashboard();
  expect(screen.queryByRole("region", { name: "Dashboard summary" })).toBeNull();
  expect(screen.queryByRole("heading", { name: "Overview" })).toBeNull();
  expect(screen.queryByText("Operational status across every visible repository.")).toBeNull();
  select(/weather-station/);
  expect(screen.getByRole("heading", { name: "weather-station" })).toBeTruthy();
  expect(screen.queryByRole("region", { name: "Dashboard summary" })).toBeNull();
});

test("shows up to three workflows on the overview and exposes the complete workflow view", () => {
  dashboard(
    ready({
      projects: [project()],
      releases: [
        run({ id: 1, title: "First deploy", state: "running", finishedAt: undefined }),
        run({ id: 2, title: "Second deploy", state: "waiting", finishedAt: undefined }),
        run({ id: 3, title: "Third deploy", state: "queued", finishedAt: undefined }),
        run({ id: 4, title: "Fourth deploy", state: "queued", finishedAt: undefined }),
      ],
    }),
  );

  expect(screen.getAllByText(/^(First|Second|Third|Fourth) deploy$/)).toHaveLength(3);
  fireEvent.click(screen.getByRole("button", { name: "View all 4 workflows" }));
  expect(screen.getAllByText(/^(First|Second|Third|Fourth) deploy$/)).toHaveLength(4);
});

test("keeps release control in the sidebar, not on the overview", async () => {
  const shipped = {
    tag: "v1.2.0",
    url: "https://github.com/octocat/weather-station/releases/v1.2.0",
    publishedAt: "2026-01-01T00:00:00Z",
  };
  const actions = fakeRunActions();
  render(
    <ActionsContext.Provider value={{ runs: actions }}>
      <DashboardView
        state={ready({
          projects: [
            project({ latestRelease: shipped, unreleased: { commits: 4, pulls: 2 } }),
            project({ repo: other, name: "home-ledger", latestRelease: shipped, unreleased: { commits: 0, pulls: 0 } }),
          ],
        })}
        now={NOW}
        refresh={() => {}}
      />
    </ActionsContext.Provider>,
  );
  expect(screen.queryByText("RELEASE CONTROL")).toBeNull();
  const nav = screen.getByRole("navigation", { name: "Repositories" });
  expect(within(nav).getByRole("button", { name: "Release controls for home-ledger, up to date" })).toBeTruthy();
  const toggle = within(nav).getByRole("button", { name: "Release controls for weather-station, 2 unreleased" });
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  fireEvent.click(toggle);
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
  const drawer = screen.getByRole("region", { name: "Release controls for weather-station" });
  expect(drawer.textContent).toContain("2 pull requests on main since");
  fireEvent.click(within(drawer).getByRole("button", { name: /Release .*weather-station/ }));
  await waitFor(() => expect(actions.release).toHaveBeenCalledOnce());
  // Once the release has started the drawer folds away by itself; the run shows on the page instead.
  await waitFor(() =>
    expect(screen.queryByRole("region", { name: "Release controls for weather-station" })).toBeNull(),
  );
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  // Still the overview: release control doesn't change what is selected.
  expectOverview();
  fireEvent.click(toggle);
  expect(screen.getByRole("region", { name: "Release controls for weather-station" })).toBeTruthy();
});

test("handles no repositories and a removed selection without leaking stale context", () => {
  const view = dashboard();
  select(/weather-station/);
  view.rerender(<DashboardView state={ready()} now={NOW} refresh={() => {}} />);
  expectOverview();
  expect(screen.getByText("No open pull requests")).toBeTruthy();
  expect(screen.getByText("Nothing running")).toBeTruthy();
  expect(screen.getByText("No repositories")).toBeTruthy();
});

test("folds the repository sidebar to a rail and remembers it across reloads", () => {
  dashboard();
  const sidebar = screen.getByRole("complementary", { name: "Repository navigation" });
  const toggle = within(sidebar).getByRole("button", { name: "Collapse sidebar" });
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
  fireEvent.click(toggle);
  expect(sidebar.closest(".workspace")?.classList.contains("sidebar-collapsed")).toBe(true);
  expect(localStorage.getItem("github-dashboard:sidebar")).toBe("collapsed");
  // Repositories keep their names for screen readers and a tooltip, and still select.
  const repo = within(screen.getByRole("navigation", { name: "Repositories" })).getByRole("button", {
    name: /^home-ledger/,
  });
  expect(repo.getAttribute("title")).toBe("home-ledger");
  expect(repo.textContent).toContain("HL");

  cleanup();
  dashboard();
  const reloaded = screen.getByRole("button", { name: "Expand sidebar" });
  expect(reloaded.getAttribute("aria-expanded")).toBe("false");
  fireEvent.click(reloaded);
  expect(localStorage.getItem("github-dashboard:sidebar")).toBeNull();
  expect(screen.getByRole("button", { name: "Collapse sidebar" })).toBeTruthy();
});

function expectOverview() {
  const sidebar = screen.getByRole("complementary", { name: "Repository navigation" });
  expect(
    within(sidebar)
      .getByRole("button", { name: /Overview/ })
      .getAttribute("aria-current"),
  ).toBe("page");
}

test("opens the repository drawer from the tab bar, and closes it on choosing a repository or Escape", () => {
  dashboard();
  const opener = screen.getByRole("button", { name: "Repositories: all" });
  expect(opener.getAttribute("aria-expanded")).toBe("false");
  fireEvent.click(opener);
  expect(opener.getAttribute("aria-expanded")).toBe("true");
  expect(document.querySelector(".workspace.sidebar-drawer-open")).not.toBeNull();
  select(/home-ledger/);
  expect(document.querySelector(".workspace.sidebar-drawer-open")).toBeNull();
  const scoped = screen.getByRole("button", { name: "Repositories: home-ledger" });
  expect(document.activeElement).toBe(scoped);
  fireEvent.click(scoped);
  fireEvent.keyDown(screen.getByRole("complementary", { name: "Repository navigation" }), { key: "Escape" });
  expect(scoped.getAttribute("aria-expanded")).toBe("false");
  fireEvent.click(scoped);
  fireEvent.click(screen.getByRole("button", { name: "Close repositories" }));
  expect(scoped.getAttribute("aria-expanded")).toBe("false");
});
