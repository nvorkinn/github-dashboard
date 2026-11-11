import type { Auth } from "./auth.ts";
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
  // TODO(merge): the next line becomes `return createDashboard(auth);`, from "./github/dashboard.ts".
  return notConnected(auth);
}

/** Stands in until the GitHub side exists: a dashboard that never has anything. */
function notConnected(_auth: Auth): Dashboard {
  return {
    state: () => ({ status: "failed", problem: "Not connected yet." }),
    subscribe: () => () => {},
    start() {},
    refresh: async () => {},
    stop() {},
  };
}
