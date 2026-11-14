import { expect, test } from "vitest";
import { readWorkflowBlob, releasePaths } from "./workflows.ts";

const file = (path: string, text: string) => ({ path, blob: readWorkflowBlob(text) });
const JOBS = "jobs:\n  build:\n    runs-on: ubuntu-latest\n";

test("a repository that marks none of its files goes by their names", () => {
  const files = [
    file(".github/workflows/ci.yml", `name: CI\n${JOBS}`),
    file(".github/workflows/ship.yml", `name: Deploy to prod\n${JOBS}`),
    // Without a name, GitHub calls a workflow by its path.
    file(".github/workflows/release.yml", JOBS),
  ];
  expect(releasePaths(files)).toEqual([".github/workflows/ship.yml", ".github/workflows/release.yml"]);
});

test("once a file is marked, names no longer count", () => {
  const files = [
    file(".github/workflows/ci.yml", `name: CI\n# dashboard: release\n${JOBS}`),
    file(".github/workflows/release.yml", `name: Release\n${JOBS}`),
  ];
  expect(releasePaths(files)).toEqual([".github/workflows/ci.yml"]);
});

test("a file that couldn't be read is no release, unless its path says so", () => {
  expect(
    releasePaths([
      { path: ".github/workflows/ci.yml", blob: undefined },
      { path: ".github/workflows/deploy.yml", blob: undefined },
    ]),
  ).toEqual([".github/workflows/deploy.yml"]);
});
