import { useEffect, useState } from "preact/hooks";
import type { Auth, AuthState } from "./auth.ts";
import { Account } from "./components/Account.tsx";
import { DashboardView, Freshness, useRefresh } from "./components/DashboardView.tsx";
import { useDashboardState, useNow } from "./components/hooks.ts";
import type { Dashboard } from "./model.ts";

/** The page: sign-in, and behind it the dashboard. */
export function App({ auth, dashboard, demo = false }: { auth: Auth; dashboard: Dashboard; demo?: boolean }) {
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
          Demo: sample data, nothing here is real.
        </p>
      )}
      {signedIn ? (
        <SignedIn auth={auth} dashboard={dashboard} />
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

function SignedIn({ auth, dashboard }: { auth: Auth; dashboard: Dashboard }) {
  const state = useDashboardState(dashboard);
  const now = useNow();
  const { refresh, pending } = useRefresh(dashboard);
  return (
    <>
      <header class="top">
        <h1>GitHub dashboard</h1>
        <div class="top-controls">
          <Freshness state={state} now={now} refresh={refresh} pending={pending} />
          <Account auth={auth} />
        </div>
      </header>
      <main>
        <DashboardView state={state} now={now} refresh={refresh} />
      </main>
    </>
  );
}

function useAuthState(auth: Auth): AuthState {
  const [state, setState] = useState(auth.state());
  useEffect(() => {
    setState(auth.state());
    return auth.subscribe(() => setState(auth.state()));
  }, [auth]);
  return state;
}
