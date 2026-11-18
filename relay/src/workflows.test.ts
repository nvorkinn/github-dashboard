import { afterEach, expect, test, vi } from "vitest";
import { blob, fakeApp, settle } from "./testing.ts";
import { createDefinitions } from "./workflows.ts";

const REPO = "nvorkinn/countdown";
const FOLDER = `repos/${REPO}/contents/.github/workflows`;
const file = (name: string, sha: string) => ({ type: "file", path: `.github/workflows/${name}`, sha });
const workflow = (id: number, name: string, title: string, state = "active") => ({
  id,
  path: `.github/workflows/${name}`,
  name: title,
  state,
});
const RELEASE =
  "name: Release\n# dashboard: release\njobs:\n  build:\n    runs-on: x\n  ship:\n    needs: build\n    runs-on: x\n";
const CI = "name: CI\njobs:\n  test:\n    runs-on: x\n";

function countdown() {
  return fakeApp([{ repo: REPO }], {
    [FOLDER]: [file("release.yml", "r1"), file("ci.yml", "c1"), file("notes.md", "n1"), { type: "dir", path: "x" }],
    [`repos/${REPO}/git/blobs/r1`]: blob(RELEASE),
    [`repos/${REPO}/git/blobs/c1`]: blob(CI),
    [`repos/${REPO}/actions/workflows`]: {
      workflows: [
        workflow(1, "release.yml", "Release"),
        workflow(2, "ci.yml", "CI"),
        workflow(3, "promote.yml", "Promote"),
        { id: 4, path: "dynamic/pages/pages-build-deployment", name: "pages build and deployment", state: "active" },
      ],
    },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

test("reads every repository's workflow files at the start: the release ones, their jobs and Promote", async () => {
  const github = countdown();
  const changed: string[] = [];
  const definitions = createDefinitions({ app: github.app, onChange: (repo) => changed.push(repo) });
  expect(definitions.isRelease(REPO, ".github/workflows/release.yml")).toBeUndefined();
  await definitions.load();

  expect(definitions.repos()).toEqual([REPO]);
  expect(changed).toEqual([REPO]);
  expect(definitions.isRelease(REPO, ".github/workflows/release.yml")).toBe(true);
  expect(definitions.isRelease(REPO, ".github/workflows/ci.yml")).toBe(false);
  expect(definitions.releaseWorkflows(REPO)).toEqual([{ id: 1, path: ".github/workflows/release.yml" }]);
  expect(definitions.promoteWorkflow(REPO)).toBe(3);
  const release = definitions.definition(REPO, ".github/workflows/release.yml");
  expect(release?.name).toBe("Release");
  expect(release?.jobs?.map((job) => [job.key, job.needs])).toEqual([
    ["build", []],
    ["ship", ["build"]],
  ]);
  // Only the YAML files directly in the folder are read.
  expect(github.calls.filter((path) => path.includes("/git/blobs/")).sort()).toEqual([
    `repos/${REPO}/git/blobs/c1`,
    `repos/${REPO}/git/blobs/r1`,
  ]);
});

test("a repository that marks none of its files goes by their names, and a disabled workflow starts nothing", async () => {
  const github = countdown();
  github.routes[`repos/${REPO}/git/blobs/r1`] = blob(RELEASE.replace("# dashboard: release\n", ""));
  github.routes[`repos/${REPO}/git/blobs/c1`] = blob(CI.replace("CI", "Deploy docs"));
  github.routes[`repos/${REPO}/actions/workflows`] = {
    workflows: [workflow(1, "release.yml", "Release", "disabled_manually"), workflow(2, "ci.yml", "Deploy docs")],
  };
  const definitions = createDefinitions({ app: github.app });
  await definitions.load();
  expect(definitions.isRelease(REPO, ".github/workflows/release.yml")).toBe(true);
  expect(definitions.isRelease(REPO, ".github/workflows/ci.yml")).toBe(true);
  expect(definitions.releaseWorkflows(REPO)).toEqual([{ id: 2, path: ".github/workflows/ci.yml" }]);
  expect(definitions.promoteWorkflow(REPO)).toBeUndefined();
});

test("a push to the default branch reads the folder again, and only the files that changed", async () => {
  const github = countdown();
  const definitions = createDefinitions({ app: github.app });
  await definitions.load();
  github.calls.length = 0;

  const push = (ref: string) => ({
    ref,
    repository: { full_name: REPO, default_branch: "main" },
    installation: { id: 1 },
  });
  definitions.onWebhook("push", push("refs/heads/feature/x"));
  definitions.onWebhook("push", push("refs/tags/v1.0.0"));
  await definitions.settled(REPO);
  expect(github.calls).toEqual([]);

  // The mark moves from one file to the other.
  github.routes[FOLDER] = [file("release.yml", "r2"), file("ci.yml", "c2")];
  github.routes[`repos/${REPO}/git/blobs/r2`] = blob(RELEASE.replace("# dashboard: release\n", ""));
  github.routes[`repos/${REPO}/git/blobs/c2`] = blob(`# dashboard: release\n${CI}`);
  definitions.onWebhook("push", push("refs/heads/main"));
  await definitions.settled(REPO);
  expect(definitions.isRelease(REPO, ".github/workflows/release.yml")).toBe(false);
  expect(definitions.isRelease(REPO, ".github/workflows/ci.yml")).toBe(true);

  github.calls.length = 0;
  definitions.onWebhook("push", push("refs/heads/main"));
  await definitions.settled(REPO);
  expect(github.calls.sort()).toEqual([`repos/${REPO}/actions/workflows`, FOLDER]);
});

test("a repository without the folder has no workflows, and one that can't be read stays as it was", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const github = countdown();
  const definitions = createDefinitions({ app: github.app });
  await definitions.load();

  github.routes[`repos/${REPO}/actions/workflows`] = 502;
  await definitions.load();
  expect(definitions.isRelease(REPO, ".github/workflows/release.yml")).toBe(true);
  expect(warn).toHaveBeenCalledWith(`workflows of ${REPO} not read: HTTP 502`);

  github.routes[`repos/${REPO}/actions/workflows`] = { workflows: [] };
  github.routes[FOLDER] = 404;
  await definitions.load();
  expect(definitions.isRelease(REPO, ".github/workflows/release.yml")).toBe(false);
  expect(definitions.releaseWorkflows(REPO)).toEqual([]);
});

test("a change to which repositories there are reads them all again, and forgets the ones that are gone", async () => {
  const github = countdown();
  const changed: string[] = [];
  const definitions = createDefinitions({ app: github.app, onChange: (repo) => changed.push(repo) });
  await definitions.load();
  changed.length = 0;

  github.repositories.splice(0, 1, { repo: "nvorkinn/other" });
  github.routes["repos/nvorkinn/other/actions/workflows"] = { workflows: [] };
  definitions.onWebhook("installation_repositories", { action: "removed" });
  await settle();
  expect(definitions.repos()).toEqual(["nvorkinn/other"]);
  expect(definitions.isRelease(REPO, ".github/workflows/release.yml")).toBeUndefined();
  expect(changed).toEqual([REPO, "nvorkinn/other"]);
});

test("a load of only what was pushed to reads a repository again only when GitHub says it was", async () => {
  const github = countdown();
  github.repositories[0] = { repo: REPO, pushedAt: "2026-11-18T10:00:00Z" };
  const definitions = createDefinitions({ app: github.app });
  await definitions.load();

  github.calls.length = 0;
  await definitions.load({ onlyPushed: true });
  expect(github.calls).toEqual([]);

  github.repositories[0] = { repo: REPO, pushedAt: "2026-11-18T11:00:00Z" };
  await definitions.load({ onlyPushed: true });
  expect(github.calls.sort()).toEqual([`repos/${REPO}/actions/workflows`, FOLDER]);

  // A load of all of them reads it anyway, for what no push says.
  github.calls.length = 0;
  await definitions.load();
  expect(github.calls.sort()).toEqual([`repos/${REPO}/actions/workflows`, FOLDER]);
});
