import { expect, test } from "vitest";
import { createAuth } from "./auth.ts";
import { makeDashboard } from "./dashboard_source.ts";

// TODO(merge): goes with the placeholder in dashboard_source.ts.
test("outside the demo there is nothing to show yet", async () => {
  const dashboard = await makeDashboard(createAuth(), false);
  expect(dashboard.state()).toEqual({ status: "failed", problem: "Not connected yet." });
  dashboard.start();
  await dashboard.refresh();
  dashboard.stop();
  expect(dashboard.state().status).toBe("failed");
});
