import { useState } from "preact/hooks";
import type { Dashboard, DashboardState } from "../model.ts";
import { Ago } from "./Ago.tsx";
import { useHiddenProjects } from "./hooks.ts";
import { ProjectList } from "./ProjectList.tsx";
import { PullList } from "./PullList.tsx";
import { ReleaseList } from "./ReleaseList.tsx";

/** Runs `dashboard.refresh()` and knows while it is under way, also where the state doesn't say so. */
export function useRefresh(dashboard: Dashboard): { refresh: () => void; pending: boolean } {
  const [pending, setPending] = useState(false);
  return {
    pending,
    refresh() {
      setPending(true);
      // What went wrong is the dashboard's to tell, in its state.
      dashboard
        .refresh()
        .catch(() => {})
        .finally(() => setPending(false));
    },
  };
}

/** The header's part of the dashboard: how fresh the data is, and the button to read it again. */
export function Freshness({
  state,
  now,
  refresh,
  pending,
}: {
  state: DashboardState;
  now: number;
  refresh: () => void;
  pending: boolean;
}) {
  const refreshing = pending || (state.status === "ready" && state.refreshing);
  return (
    <div class="freshness">
      {state.status === "ready" && (
        <>
          <Liveness live={state.live} />
          <span class="quiet updated">
            updated <Ago at={state.readAt} now={now} />
          </span>
        </>
      )}
      <button type="button" onClick={refresh} disabled={refreshing || state.status === "loading"}>
        {refreshing ? "Refreshing…" : "Refresh"}
      </button>
    </div>
  );
}

/**
 * Whether changes arrive as they happen. A filled dot and a hollow one, so the colour isn't the only difference, and
 * the word next to it says the same.
 */
function Liveness({ live }: { live: boolean }) {
  return (
    <span
      class={`liveness ${live ? "liveness-live" : "liveness-waiting"}`}
      title={
        live
          ? "Changes on GitHub show here as they happen."
          : "Not connected for live updates. Checking GitHub every minute meanwhile."
      }
    >
      <span class="liveness-dot" aria-hidden="true" />
      {live ? "Live" : "Reconnecting"}
    </span>
  );
}

/** The dashboard itself: drawn from the state, less the projects the user has hidden. */
export function DashboardView({ state, now, refresh }: { state: DashboardState; now: number; refresh: () => void }) {
  const { hidden, toggle } = useHiddenProjects();
  if (state.status === "loading") {
    return <p class="quiet">Loading your projects…</p>;
  }
  if (state.status === "failed") {
    return (
      <div class="failed-read">
        <p role="alert" class="alert">
          {state.problem}
        </p>
        <button type="button" onClick={refresh}>
          Try again
        </button>
      </div>
    );
  }
  const { data } = state;
  // A hidden project's pull requests and runs go with it.
  const pulls = data.pulls.filter((pull) => !hidden.has(pull.repo));
  const releases = data.releases.filter((run) => !hidden.has(run.repo));
  return (
    <>
      {state.problem && (
        <p role="alert" class="alert">
          {state.problem}
        </p>
      )}
      <div class="overview">
        <PullList pulls={pulls} now={now} />
        <div class="activity">
          <ReleaseList runs={releases} now={now} />
          <ProjectList projects={data.projects} now={now} hidden={hidden} onToggle={toggle} />
        </div>
      </div>
    </>
  );
}
