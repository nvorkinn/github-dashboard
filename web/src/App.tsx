import { useEffect, useState } from "preact/hooks";
import type { Auth, AuthState } from "./auth.ts";

/** The page so far: sign-in, and who is signed in. The dashboard itself comes next. */
export function App({ auth, demo = false }: { auth: Auth; demo?: boolean }) {
  const state = useAuthState(auth);

  useEffect(() => {
    void auth.start();
  }, [auth]);

  return (
    <>
      {demo && (
        <p role="note" class="demo-note">
          Demo: sample data, nothing here is real.
        </p>
      )}
      <header class="top">
        <h1>GitHub dashboard</h1>
        {state.status === "signedIn" && <Account auth={auth} />}
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

type User = { login: string; avatar_url: string };

/** Who is signed in, and the way out. */
function Account({ auth }: { auth: Auth }) {
  const [user, setUser] = useState<User | "failed">();
  const [signOutFailed, setSignOutFailed] = useState(false);

  useEffect(() => {
    auth
      .github("user")
      .then(async (response) => setUser(response.ok ? ((await response.json()) as User) : "failed"))
      .catch(() => setUser("failed"));
  }, [auth]);

  return (
    <div class="account">
      {user === "failed" && <span class="problem">Couldn't load your GitHub account</span>}
      {user && user !== "failed" && (
        <>
          <img class="avatar" src={user.avatar_url} alt="" width="28" height="28" />
          <span class="login">{user.login}</span>
        </>
      )}
      {signOutFailed && (
        <span role="alert" class="problem">
          Sign-out didn't work
        </span>
      )}
      <button type="button" onClick={async () => setSignOutFailed(!(await auth.signOut()))}>
        Sign out
      </button>
    </div>
  );
}
