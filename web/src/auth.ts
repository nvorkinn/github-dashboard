/**
 * `unavailable`: the relay (or GitHub behind it) didn't answer, so it isn't known whether the user is signed in.
 * `failed` on `signedOut`: the user just came back from a sign-in that didn't work.
 */
export type AuthState =
  | { status: "loading" }
  | { status: "signedOut"; failed: boolean }
  | { status: "signedIn" }
  | { status: "unavailable" };

export type Auth = {
  state(): AuthState;
  /** Calls `listener` on every change of state; returns how to stop. */
  subscribe(listener: () => void): () => void;
  /** Finds out whether the user is signed in. Call once, when the page loads. */
  start(): Promise<void>;
  /** Calls api.github.com as the signed-in user. `path` is relative to it, such as `user`. */
  github(path: string, init?: RequestInit): Promise<Response>;
  /** Whether the sign-out went through. */
  signOut(): Promise<boolean>;
};

// Ask for a new token this long before the old one runs out.
const REFRESH_EARLY_MS = 5 * 60_000;
const RETRY_MS = 60_000;
// setTimeout can't wait longer than this.
const MAX_TIMER_MS = 2 ** 31 - 1;
const GITHUB_API_VERSION = "2022-11-28";

/**
 * The page's side of the sign-in. The access token lives in this closure and nowhere else: not in storage, not in a
 * cookie, not in the DOM, so a reload starts without one and asks the relay again. The relay answers from the
 * refresh token in its cookie, which scripts can't read.
 */
export function createAuth(): Auth {
  let token: { value: string; expiresAt: number } | undefined;
  let state: AuthState = { status: "loading" };
  let timer: ReturnType<typeof setTimeout> | undefined;
  let refreshing: Promise<boolean> | undefined;
  const listeners = new Set<() => void>();

  function setState(next: AuthState): void {
    state = next;
    for (const listener of listeners) {
      listener();
    }
  }

  function schedule(delay: number): void {
    clearTimeout(timer);
    timer = setTimeout(() => void refresh(), Math.min(Math.max(delay, 0), MAX_TIMER_MS));
  }

  function forget(): void {
    token = undefined;
    clearTimeout(timer);
  }

  /** Gets a new access token from the relay. Whether there is a usable token afterwards. */
  function refresh(): Promise<boolean> {
    // One at a time: callers that arrive during a refresh share it.
    refreshing ??= acrossTabs(requestToken).finally(() => {
      refreshing = undefined;
    });
    return refreshing;
  }

  async function requestToken(): Promise<boolean> {
    let response: Response | undefined;
    try {
      response = await fetch("api/auth/token", { method: "POST" });
    } catch {
      // Handled below, like an answer that isn't a token.
    }

    if (response?.status === 401) {
      forget();
      setState({ status: "signedOut", failed: false });
      return false;
    }
    const body = response?.ok ? await response.json().catch(() => undefined) : undefined;
    if (typeof body?.access_token === "string" && typeof body?.expires_at === "number") {
      token = { value: body.access_token, expiresAt: body.expires_at };
      // Never sooner than the retry delay, so an odd expiry can't make this spin.
      schedule(Math.max(token.expiresAt - Date.now() - REFRESH_EARLY_MS, RETRY_MS));
      setState({ status: "signedIn" });
      return true;
    }

    // The relay or GitHub is having trouble. A token that still works is kept while this tries again.
    if (token && token.expiresAt > Date.now()) {
      schedule(RETRY_MS);
      return true;
    }
    forget();
    setState({ status: "unavailable" });
    return false;
  }

  function send(path: string, init: RequestInit | undefined, accessToken: string): Promise<Response> {
    const headers = new Headers(init?.headers);
    headers.set("Authorization", `Bearer ${accessToken}`);
    headers.set("Accept", "application/vnd.github+json");
    headers.set("X-GitHub-Api-Version", GITHUB_API_VERSION);
    return fetch(new URL(path, "https://api.github.com/"), { ...init, headers });
  }

  return {
    state: () => state,

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    async start() {
      const url = new URL(location.href);
      const failed = url.searchParams.get("signin") === "failed";
      if (failed) {
        // Said once: a reload or a bookmark shouldn't bring the message back.
        url.searchParams.delete("signin");
        history.replaceState(null, "", url);
      }
      await refresh();
      if (failed && state.status === "signedOut") {
        setState({ status: "signedOut", failed: true });
      }
    },

    async github(path, init) {
      // A tab that slept through its timer may hold a token that has run out.
      if (!token || token.expiresAt <= Date.now()) {
        await refresh();
      }
      if (!token) {
        throw new Error("Not signed in");
      }
      const response = await send(path, init, token.value);
      // GitHub can drop a token early (the user revoked it, say): get a new one and try once more.
      if (response.status === 401 && (await refresh()) && token) {
        return send(path, init, token.value);
      }
      return response;
    },

    async signOut() {
      try {
        const response = await fetch("api/auth/logout", { method: "POST" });
        if (!response.ok) {
          return false;
        }
      } catch {
        return false;
      }
      forget();
      setState({ status: "signedOut", failed: false });
      return true;
    },
  };
}

/**
 * Runs `task` while no other tab of the page is running its own. A refresh replaces the refresh token, so two tabs
 * refreshing at once would have one of them sending a token that has just stopped working.
 */
function acrossTabs<T>(task: () => Promise<T>): Promise<T> {
  // Web Locks need a secure context and a current browser; without them the relay's own guard has to do.
  if (typeof navigator === "undefined" || !navigator.locks) {
    return task();
  }
  return navigator.locks.request("github-dashboard-token-refresh", task) as Promise<T>;
}
