// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/preact";
import { afterEach, expect, test } from "vitest";
import type { Project } from "../model.ts";
import { ActionsContext } from "./actions.tsx";
import { ProjectList } from "./ProjectList.tsx";
import { before, fakeRunActions, NOW, project } from "./testing.ts";

afterEach(cleanup);

function withActions(projects: Project[], actions = fakeRunActions()) {
  render(
    <ActionsContext.Provider value={{ runs: actions }}>
      <ProjectList now={NOW} projects={projects} />
    </ActionsContext.Provider>,
  );
  return actions;
}

const released = (tag: string) => ({
  tag,
  url: `https://github.com/octocat/weather-station/releases/tag/${tag}`,
  publishedAt: before(86_400_000),
});

test("Release works out the tag, asks naming it, and releases it on Confirm", async () => {
  const one = project({ latestRelease: released("v1.2.3") });
  const actions = withActions([one]);
  fireEvent.click(screen.getByRole("button", { name: "Release weather-station" }));
  expect(actions.nextRelease).toHaveBeenCalledWith(one);
  expect(await screen.findByText("Release v1.3.0?")).toBeTruthy();
  expect(actions.release).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
  expect(actions.release).toHaveBeenCalledWith(one, "v1.3.0");
  expect((await screen.findByRole("status")).textContent).toBe("Released v1.3.0.");
});

test("Release says why it can't, next to the button", async () => {
  const actions = fakeRunActions();
  actions.nextRelease.mockRejectedValueOnce(
    new Error("Tag v1.3.0 already exists. Resolve it on GitHub before releasing."),
  );
  withActions([project()], actions);
  fireEvent.click(screen.getByRole("button", { name: "Release weather-station" }));
  expect((await screen.findByRole("alert")).textContent).toBe(
    "Tag v1.3.0 already exists. Resolve it on GitHub before releasing.",
  );
  expect(actions.release).not.toHaveBeenCalled();
});

test("Promote is offered for the latest release of a project with a Promote workflow, and asks first", async () => {
  const promotable = project({ promoteWorkflow: 31, latestRelease: released("v1.2.3") });
  const actions = withActions([
    promotable,
    project({ repo: "octocat/a", name: "a", promoteWorkflow: undefined, latestRelease: released("v2.0.0") }),
    project({ repo: "octocat/b", name: "b", promoteWorkflow: 32, latestRelease: undefined }),
    project({ repo: "octocat/c", name: "c", promoteWorkflow: 33, latestRelease: released("v2.0.0-rc.1") }),
  ]);
  expect(screen.getAllByRole("button", { name: /^Promote/ }).map((button) => button.textContent)).toEqual([
    "Promote v1.2.3",
  ]);
  fireEvent.click(screen.getByRole("button", { name: "Promote weather-station v1.2.3" }));
  expect(screen.getByText("Promote v1.2.3?")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
  expect(actions.promote).toHaveBeenCalledWith(promotable, "v1.2.3");
  expect((await screen.findByRole("status")).textContent).toBe("Promote of v1.2.3 started.");
});

test("without actions the list only shows", () => {
  render(<ProjectList now={NOW} projects={[project({ promoteWorkflow: 31, latestRelease: released("v1.2.3") })]} />);
  expect(screen.queryByRole("button")).toBeNull();
});

test("says so when there are none", () => {
  render(<ProjectList projects={[]} now={NOW} />);
  expect(screen.getByText("No projects")).toBeTruthy();
});

test("draws a row per project, by name", () => {
  render(
    <ProjectList
      now={NOW}
      projects={[
        project({
          repo: "octocat/weather-station",
          name: "weather-station",
          latestRelease: {
            tag: "v2.4.1",
            url: "https://github.com/octocat/weather-station/releases/tag/v2.4.1",
            publishedAt: before(3 * 86_400_000),
          },
        }),
        project({
          repo: "octocat/home-ledger",
          name: "home-ledger",
          url: "https://github.com/octocat/home-ledger",
          private: true,
        }),
      ]}
    />,
  );
  expect(screen.getByRole("heading").textContent).toBe("Projects & releases 2");
  const [ledger, weather] = screen.getAllByRole("listitem") as [HTMLElement, HTMLElement];

  expect(within(ledger).getByRole("link", { name: "home-ledger" }).getAttribute("href")).toBe(
    "https://github.com/octocat/home-ledger",
  );
  expect(within(ledger).getByText("Private")).toBeTruthy();
  expect(within(ledger).getByText("no release yet")).toBeTruthy();

  expect(within(weather).queryByText("Private")).toBeNull();
  expect(within(weather).getByRole("link", { name: "v2.4.1" }).getAttribute("href")).toBe(
    "https://github.com/octocat/weather-station/releases/tag/v2.4.1",
  );
  expect(within(weather).getByText("3d ago")).toBeTruthy();
});

test("a hidden project leaves the rows and waits under them to be shown again", () => {
  const toggled: string[] = [];
  render(
    <ProjectList
      now={NOW}
      projects={[project(), project({ repo: "octocat/home-ledger", name: "home-ledger" })]}
      hidden={new Set(["octocat/home-ledger"])}
      onToggle={(repo) => toggled.push(repo)}
    />,
  );
  expect(screen.getAllByRole("heading").map((heading) => heading.textContent)).toEqual([
    "Projects & releases 1",
    "Hidden 1",
  ]);
  expect(screen.queryByRole("link", { name: "home-ledger" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Show home-ledger" }));
  fireEvent.click(screen.getByRole("button", { name: "Hide weather-station" }));
  expect(toggled).toEqual(["octocat/home-ledger", "octocat/weather-station"]);
});

test("says so when every project is hidden", () => {
  render(<ProjectList now={NOW} projects={[project()]} hidden={new Set(["octocat/weather-station"])} />);
  expect(screen.getByText("Every project is hidden")).toBeTruthy();
});
