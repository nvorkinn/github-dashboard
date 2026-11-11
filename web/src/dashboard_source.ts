import type { Auth } from "./auth.ts";
import type { Actions } from "./components/actions.tsx";
import { createDashboard } from "./github/dashboard.ts";
import { createPullActions } from "./github/pull_actions.ts";
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
 * What the page can do to what `dashboard` shows: on GitHub, or, in the demo, to the demo's sample data, which only
 * the demo's own dashboard knows how to change.
 */
export async function makeActions(auth: Auth, dashboard: Dashboard, demo: boolean): Promise<Actions> {
  if (demo && import.meta.env.MODE === "demo") {
    const { demoPullActions } = await import("./demo/dashboard.ts");
    const pulls = demoPullActions(dashboard);
    return pulls ? { pulls } : {};
  }
  return { pulls: createPullActions(auth, dashboard) };
}
