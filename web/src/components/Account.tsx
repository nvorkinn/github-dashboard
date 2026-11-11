import { useEffect, useState } from "preact/hooks";
import type { Auth } from "../auth.ts";

type User = { login: string; avatar_url: string };

/** Who is signed in, and the way out. */
export function Account({ auth }: { auth: Auth }) {
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
