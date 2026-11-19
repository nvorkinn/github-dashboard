import type { Auth } from "./auth.ts";
import type { Actions } from "./components/actions.tsx";
import { readHidden } from "./components/hooks.ts";
import { createApi } from "./github/api.ts";
import { createDashboard } from "./github/dashboard.ts";
import { createFilesReader } from "./github/files.ts";
import type { Shape } from "./github/graphql.ts";
import { createImageReader } from "./github/images.ts";
import { createPullActions } from "./github/pull_actions.ts";
import { createRepositoryConfig } from "./github/repository_config.ts";
import { createReviewService } from "./github/review.ts";
import { createRunActions } from "./github/run_actions.ts";
import { createSecretCopy } from "./github/secret_copy.ts";
import type { Dashboard } from "./model.ts";
import { labelled } from "./telemetry.ts";

/**
 * Where the browser keeps which projects a read asks about (see `Shape`): their names, so that a reload reads
 * everything in one round of requests. Nothing of what GitHub answered, and nothing of the sign-in.
 */
export const SHAPE_KEY = "github-dashboard:shape";

const keptShape = {
  load(): Shape | undefined {
    const kept: unknown = JSON.parse(localStorage.getItem(SHAPE_KEY) ?? "null");
    if (typeof kept !== "object" || kept === null) {
      return undefined;
    }
    // An older version kept each project's workflow files under its name.
    const names: unknown[] = Array.isArray(kept) ? kept : Object.keys(kept);
    return names.filter((name): name is string => typeof name === "string");
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
    const { demoFiles, demoImage } = await import("./demo/files.ts");
    const { demoReview } = await import("./demo/review.ts");
    return {
      ...(pulls ? { pulls } : {}),
      ...(runs ? { runs } : {}),
      files: demoFiles,
      image: demoImage,
      review: demoReview,
    };
  }
  return {
    // Each labelled with what it is for, for the telemetry (telemetry.ts).
    review: createReviewService(labelled(auth, "review"), dashboard),
    repositories: createRepositoryConfig(labelled(auth, "settings"), dashboard),
    secrets: createSecretCopy(labelled(auth, "secrets")),
    pulls: createPullActions(labelled(auth, "action.pull"), dashboard),
    runs: createRunActions(labelled(auth, "action.run"), dashboard),
    files: createFilesReader(createApi(labelled(auth, "review.files"))),
    image: createImageReader(labelled(auth, "review.image")),
  };
}
