import type { Auth } from "./auth.ts";
import type { Actions } from "./components/actions.tsx";
import { createDashboard } from "./github/dashboard.ts";
import { createRunActions } from "./github/run_actions.ts";
import type { Dashboard } from "./model.ts";

/**
 * Where the page's dashboard comes from: the demo's sample data, or GitHub. The one place that knows which, so the
 * rest of the page only sees a `Dashboard`.
 */
export async function makeDashboard(auth: Auth, demo: boolean): Promise<Dashboard> {
  // The mode is spelled out so that the real build drops this branch, and the sample data with it.
  if (demo && import.meta.env.MODE === "demo") {
    const { createDemoDashboard } = await import("./demo/dashboard.ts");
    // `?show=problem` and the like put the demo into a state its script never reaches.
    return createDemoDashboard({ show: new URLSearchParams(location.search).get("show") ?? undefined });
  }
  return createDashboard(auth);
}

/**
 * What the page can do to `dashboard`'s data: on GitHub as the signed-in user, or, for the demo's dashboard, on its
 * sample data.
 */
export async function makeActions(auth: Auth, dashboard: Dashboard, demo: boolean): Promise<Actions> {
  if (demo && import.meta.env.MODE === "demo") {
    const { isDemoDashboard } = await import("./demo/dashboard.ts");
    if (isDemoDashboard(dashboard)) {
      return { runs: dashboard.runActions };
    }
  }
  return { runs: createRunActions(auth, dashboard) };
}
