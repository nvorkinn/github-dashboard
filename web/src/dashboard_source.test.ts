import { expect, test } from "vitest";
import { createAuth } from "./auth.ts";
import { makeActions, makeDashboard, SHAPE_KEY } from "./dashboard_source.ts";

test("outside the demo the dashboard reads GitHub, and has read nothing until started", async () => {
  const dashboard = await makeDashboard(createAuth(), false);
  expect(dashboard.state()).toEqual({ status: "loading" });
});

test("the demo flag alone doesn't bring in the sample data: the build has to be the demo's", async () => {
  const dashboard = await makeDashboard(createAuth(), true);
  expect(dashboard.state()).toEqual({ status: "loading" });
});

test("outside the demo the actions are GitHub's, whatever the demo flag says", async () => {
  for (const demo of [false, true]) {
    const auth = createAuth();
    const actions = await makeActions(auth, await makeDashboard(auth, demo), demo);
    expect(Object.keys(actions.pulls ?? {}).sort()).toEqual(["merge", "requestRebase", "setAutoMerge", "updateBranch"]);
    expect(Object.keys(actions.runs ?? {}).sort()).toEqual([
      "nextRelease",
      "promote",
      "release",
      "rerunFailed",
      "rerunJob",
      "review",
    ]);
  }
});

test("which projects to ask about is kept between visits as their names, also when an older version kept more", async () => {
  // @ts-expect-error a browser's storage, as far as it is used.
  globalThis.localStorage = {
    kept: JSON.stringify({ "octo/app": [".github/workflows/release.yml"], "octo/lib": [] }),
    getItem(key: string) {
      return key === SHAPE_KEY ? this.kept : null;
    },
    setItem(key: string, value: string) {
      if (key === SHAPE_KEY) {
        this.kept = value;
      }
    },
  };
  const queries: string[] = [];
  const auth = {
    ...createAuth(),
    async github(_path: string, init?: RequestInit) {
      queries.push(String(JSON.parse(String(init?.body)).query));
      return Response.json({ data: { viewer: { repositories: { pageInfo: {}, nodes: [] } }, r0: null, r1: null } });
    },
  };
  const dashboard = await makeDashboard(auth, false);
  dashboard.start();
  await new Promise((resolve) => setTimeout(resolve, 20));
  dashboard.stop();
  // The first read already asks about both projects, by name, beside the list of them.
  expect(queries).toHaveLength(2);
  expect(queries[1]).toContain('r0: repository(owner: "octo", name: "app")');
  expect(queries[1]).toContain('r1: repository(owner: "octo", name: "lib")');
  expect(globalThis.localStorage.getItem(SHAPE_KEY)).toBe("[]");
  // @ts-expect-error put back as it was.
  delete globalThis.localStorage;
});
