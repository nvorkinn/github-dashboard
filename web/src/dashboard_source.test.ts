import { expect, test } from "vitest";
import { createAuth } from "./auth.ts";
import { makeActions, makeDashboard } from "./dashboard_source.ts";

test("outside the demo the dashboard reads GitHub, and has read nothing until started", async () => {
  const dashboard = await makeDashboard(createAuth(), false);
  expect(dashboard.state()).toEqual({ status: "loading" });
});

test("outside the demo build the actions are GitHub's, for the demo flag too", async () => {
  for (const demo of [false, true]) {
    const auth = createAuth();
    const actions = await makeActions(auth, await makeDashboard(auth, demo), demo);
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

test("the demo flag alone doesn't bring in the sample data: the build has to be the demo's", async () => {
  const dashboard = await makeDashboard(createAuth(), true);
  expect(dashboard.state()).toEqual({ status: "loading" });
});
