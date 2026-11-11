import { useState } from "preact/hooks";
import type { Dashboard, DashboardState } from "../model.ts";
import { Ago } from "./Ago.tsx";
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
        <span class="quiet updated">
          updated <Ago at={state.readAt} now={now} />
        </span>
      )}
      <button type="button" onClick={refresh} disabled={refreshing || state.status === "loading"}>
        {refreshing ? "Refreshing…" : "Refresh"}
      </button>
    </div>
  );
}

/** The dashboard itself: read-only, drawn from the state and nothing else. */
export function DashboardView({ state, now, refresh }: { state: DashboardState; now: number; refresh: () => void }) {
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
  return (
    <>
      {state.problem && (
        <p role="alert" class="alert">
          {state.problem}
        </p>
      )}
      <div class="overview">
        <PullList pulls={data.pulls} now={now} />
        <div class="activity">
          <ReleaseList runs={data.releases} now={now} />
          <ProjectList projects={data.projects} now={now} />
        </div>
      </div>
    </>
  );
}
