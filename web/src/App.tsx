import { useEffect, useMemo, useState } from "preact/hooks";
import type { Auth, AuthState } from "./auth.ts";
import { Account } from "./components/Account.tsx";
import { type Actions, ActionsContext } from "./components/actions.tsx";
import { DashboardView, Freshness, useRefresh } from "./components/DashboardView.tsx";
import { ExternalLink } from "./components/ExternalLink.tsx";
import { readHidden, useDashboardState, useNow } from "./components/hooks.ts";
import { Icon, type IconName } from "./components/Icon.tsx";
import { Settings } from "./components/Settings.tsx";
import { useLaneColumns, useView, ViewSwitch } from "./components/ViewSwitch.tsx";
import { type Dashboard, type DashboardState, summarize } from "./model.ts";
import { createNotifier, type Notifier } from "./notifications.ts";

/** The pull request a demo was built from, which its note links back to. */
export interface DemoPull {
  number: number;
  title: string;
  url: string;
}

/**
 * The page: sign-in, and behind it the dashboard. Without `actions` the dashboard only shows. `pull` is set on a pull
 * request's demo.
 */
export function App({
  auth,
  dashboard,
  actions,
  demo = false,
  notifier,
  pull,
}: {
  auth: Auth;
  dashboard: Dashboard;
  actions?: Actions | undefined;
  demo?: boolean;
  /** Shows the desktop notifications. Left out, the browser's, as the settings page sets them. */
  notifier?: Notifier | undefined;
  pull?: DemoPull | undefined;
}) {
  const state = useAuthState(auth);
  const signedIn = state.status === "signedIn";

  useEffect(() => {
    void auth.start();
  }, [auth]);

  // The dashboard reads as the signed-in user, so it runs exactly as long as there is one.
  useEffect(() => {
    if (!signedIn) {
      return;
    }
    dashboard.start();
    return () => dashboard.stop();
  }, [signedIn, dashboard]);

  return (
    <>
      {demo && (
        <p role="note" class="demo-note">
          {pull ? (
            <>
              Demo of{" "}
              <ExternalLink href={pull.url}>
                #{pull.number} {pull.title}
              </ExternalLink>
              : sample data, nothing here is real.
            </>
          ) : (
            "Demo: sample data, nothing here is real."
          )}
        </p>
      )}
      {signedIn ? (
        <SignedIn auth={auth} dashboard={dashboard} actions={actions} notifier={notifier} />
      ) : (
        <>
          <header class="top">
            <h1>GitHub dashboard</h1>
          </header>
          <main>
            {state.status === "loading" && <p class="quiet">Loading…</p>}
            {state.status === "signedOut" && (
              <>
                {state.failed && (
                  <p role="alert" class="problem">
                    Sign-in didn't work. Try again.
                  </p>
                )}
                {/* A plain link: signing in is a trip to github.com and back, which the relay starts. */}
                <a class="button" href="api/auth/login">
                  Sign in with GitHub
                </a>
              </>
            )}
            {state.status === "unavailable" && (
              <p role="alert" class="problem">
                Can't reach the sign-in service. Reload to try again.
              </p>
            )}
          </main>
        </>
      )}
    </>
  );
}

function SignedIn({
  auth,
  dashboard,
  actions,
  notifier: given,
}: {
  auth: Auth;
  dashboard: Dashboard;
  actions: Actions | undefined;
  notifier: Notifier | undefined;
}) {
  const state = useDashboardState(dashboard);
  const now = useNow();
  const { refresh, pending } = useRefresh(dashboard);
  const page = usePage();
  const notifier = useMemo(() => given ?? createNotifier({ hidden: readHidden }), [given]);

  // What needs attention shows as a desktop notification, for as long as the dashboard runs.
  useEffect(() => dashboard.onNotice?.((notice) => notifier.notify(notice)), [dashboard, notifier]);

  const [view, setView] = useView();
  const [laneColumns, setLaneColumns] = useLaneColumns();
  const commandCentre = view === "workspace" && page === "dashboard";
  return (
    <>
      {commandCentre && (
        <a class="skip-link" href="#workspace-content">
          Skip to dashboard content
        </a>
      )}
      <header class={commandCentre ? "top command-top" : "top"}>
        <div class={commandCentre ? "command-brand" : undefined}>
          {commandCentre && (
            <span class="command-mark">
              <Icon name="command" size={22} />
            </span>
          )}
          <h1>
            <a class="home" href="#dashboard">
              {commandCentre ? "GitHub Command Centre" : "GitHub dashboard"}
            </a>
          </h1>
          {commandCentre && <p>Build · Review · Release · Operate</p>}
        </div>
        {commandCentre && <CommandSummary state={state} />}
        <div class="top-controls">
          <ViewSwitch
            view={view}
            onChange={(next) => {
              setView(next);
              // Picking a view from the settings page goes to it.
              if (page === "settings") {
                location.hash = "#dashboard";
              }
            }}
          />
          <Freshness state={state} now={now} refresh={refresh} pending={pending} />
          <a class="button" href="#settings" aria-current={page === "settings" ? "page" : undefined}>
            Settings
          </a>
          <Account auth={auth} />
        </div>
      </header>
      <main class={commandCentre ? "command-main" : undefined}>
        {page === "settings" ? (
          <Settings notifier={notifier} laneColumns={laneColumns} onLaneColumns={setLaneColumns} />
        ) : (
          <ActionsContext.Provider value={actions}>
            <DashboardView state={state} now={now} refresh={refresh} view={view} laneColumns={laneColumns} />
          </ActionsContext.Provider>
        )}
      </main>
    </>
  );
}

function CommandSummary({ state }: { state: DashboardState }) {
  if (state.status !== "ready") {
    return (
      <div class="command-summary command-summary-loading" role="status">
        <span class="visually-hidden">Loading dashboard summary</span>
      </div>
    );
  }
  const active = state.data.releases.filter(
    (run) => ["running", "waiting", "queued"].includes(run.state) && !run.finishedAt,
  ).length;
  const ready = state.data.pulls.filter((pull) => {
    const checks = summarize(pull.checks);
    return !pull.draft && pull.mergeState === "clean" && (checks === "passed" || checks === "none");
  }).length;
  const attention =
    state.data.pulls.filter((pull) => {
      const checks = summarize(pull.checks);
      return checks === "failed" || pull.mergeState === "conflicts" || pull.mergeState === "behind";
    }).length +
    state.data.releases.filter(
      (run) =>
        run.state === "failed" || run.state === "cancelled" || run.state === "waiting" || run.approvals.length > 0,
    ).length;
  const metrics: { label: string; value: number; icon: IconName; tone: string }[] = [
    { label: "Open PRs", value: state.data.pulls.length, icon: "pull-request", tone: "done" },
    { label: "Running", value: active, icon: "workflow", tone: "running" },
    { label: "Ready PRs", value: ready, icon: "check", tone: "done" },
    { label: "Attention", value: attention, icon: "attention", tone: attention ? "waiting" : "done" },
  ];
  return (
    <section class="command-summary" aria-label="Global dashboard summary">
      {metrics.map((metric) => (
        <div key={metric.label} class={`command-stat command-stat-${metric.tone}`}>
          <span class="command-stat-icon" aria-hidden="true">
            <Icon name={metric.icon} size={17} />
          </span>
          <strong>{metric.value}</strong>
          <span>{metric.label}</span>
        </div>
      ))}
    </section>
  );
}

type Page = "dashboard" | "settings";

/** Which page the address names: `#settings` the settings, anything else the dashboard. Back and forward work. */
function usePage(): Page {
  const read = (): Page =>
    typeof location !== "undefined" && location.hash === "#settings" ? "settings" : "dashboard";
  const [page, setPage] = useState(read);
  useEffect(() => {
    const onHash = () => setPage(read());
    // Read again too, for a change between drawing and listening.
    onHash();
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  return page;
}

function useAuthState(auth: Auth): AuthState {
  const [state, setState] = useState(auth.state());
  useEffect(() => {
    setState(auth.state());
    return auth.subscribe(() => setState(auth.state()));
  }, [auth]);
  return state;
}
