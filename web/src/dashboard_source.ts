import type { Auth } from "./auth.ts";
import type { Actions } from "./components/actions.tsx";
import { readHidden } from "./components/hooks.ts";
import { createApi } from "./github/api.ts";
import { createDashboard } from "./github/dashboard.ts";
import { createFilesReader } from "./github/files.ts";
import type { Shape } from "./github/graphql.ts";
import { createPullActions } from "./github/pull_actions.ts";
import { createReviewService } from "./github/review.ts";
import { createRunActions } from "./github/run_actions.ts";
import type { Dashboard } from "./model.ts";

/**
 * Where the browser keeps which workflows a read asks about (see `Shape`): names of projects and of workflow files,
 * so that a reload reads everything in one request. Nothing of what GitHub answered, and nothing of the sign-in.
 */
export const SHAPE_KEY = "github-dashboard:shape";

const keptShape = {
  load(): Shape | undefined {
    const kept: unknown = JSON.parse(localStorage.getItem(SHAPE_KEY) ?? "null");
    if (typeof kept !== "object" || kept === null || Array.isArray(kept)) {
      return undefined;
    }
    const shape: Shape = {};
    for (const [repo, paths] of Object.entries(kept)) {
      if (Array.isArray(paths)) {
        shape[repo] = paths.filter((path): path is string => typeof path === "string");
      }
    }
    return shape;
  },
  save(shape: Shape): void {
    localStorage.setItem(SHAPE_KEY, JSON.stringify(shape));
  },
};

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
  return createDashboard(auth, { hidden: readHidden, shape: keptShape });
}

/**
 * What the page can do to what `dashboard` shows: on GitHub as the signed-in user, or, in the demo, to the demo's
 * sample data, which only the demo's own dashboard knows how to change.
 */
export async function makeActions(auth: Auth, dashboard: Dashboard, demo: boolean): Promise<Actions> {
  if (demo && import.meta.env.MODE === "demo") {
    const { demoPullActions, demoRunActions } = await import("./demo/dashboard.ts");
    const pulls = demoPullActions(dashboard);
    const runs = demoRunActions(dashboard);
    return { ...(pulls ? { pulls } : {}), ...(runs ? { runs } : {}) };
  }
  return {
    review: createReviewService(auth, dashboard),
    pulls: createPullActions(auth, dashboard),
    runs: createRunActions(auth, dashboard),
    files: createFilesReader(createApi(auth)),
  };
}
