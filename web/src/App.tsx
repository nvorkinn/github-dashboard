import { useEffect, useMemo, useState } from "preact/hooks";
import type { Auth, AuthState } from "./auth.ts";
import { Account } from "./components/Account.tsx";
import { type Actions, ActionsContext } from "./components/actions.tsx";
import { DashboardView, Freshness, useRefresh } from "./components/DashboardView.tsx";
import { readHidden, useDashboardState, useNow } from "./components/hooks.ts";
import { Settings } from "./components/Settings.tsx";
import { useView, ViewSwitch } from "./components/ViewSwitch.tsx";
import type { Dashboard } from "./model.ts";
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
              <a href={pull.url}>
                #{pull.number} {pull.title}
              </a>
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
  return (
    <>
      <header class="top">
        <h1>
          <a class="home" href="#dashboard">
            GitHub dashboard
          </a>
        </h1>
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
      <main>
        {page === "settings" ? (
          <Settings notifier={notifier} />
        ) : (
          <ActionsContext.Provider value={actions}>
            <DashboardView state={state} now={now} refresh={refresh} view={view} />
          </ActionsContext.Provider>
        )}
      </main>
    </>
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
