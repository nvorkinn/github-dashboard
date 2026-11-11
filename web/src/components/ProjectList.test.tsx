// @vitest-environment happy-dom
import { cleanup, render, screen, within } from "@testing-library/preact";
import { afterEach, expect, test } from "vitest";
import { ProjectList } from "./ProjectList.tsx";
import { before, NOW, project } from "./testing.ts";

afterEach(cleanup);

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
          description: "Reads the roof sensors",
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
  expect(within(weather).getByText("Reads the roof sensors")).toBeTruthy();
});
