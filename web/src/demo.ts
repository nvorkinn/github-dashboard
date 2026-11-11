import { AVATARS } from "./demo/avatars.ts";

/**
 * The demo: the page running on built-in sample data, with no relay, sign-in or GitHub behind it. Each pull request's
 * preview is built this way (`npm run build:demo`), so a change can be looked at and clicked through before merging.
 * Only a demo build loads this file. It stands in for the sign-in; what the dashboard shows comes from
 * `demo/dashboard.ts` and the sample data in `demo/data.ts`.
 *
 * The demo starts signed in. Signing out and in again works, without the trip to github.com: `onSignIn` is told
 * when the sign-in link was clicked, to ask for the token again as a fresh page load would.
 */
export function installDemo(options: { onSignIn: () => void }): void {
  let signedIn = true;

  /** The sample answer to a call to the relay, or nothing for a path the demo doesn't stand in for. */
  function relay(path: string): Response | undefined {
    if (path.endsWith("/api/auth/token")) {
      return signedIn
        ? Response.json({ access_token: "demo-token", expires_at: Date.now() + 8 * 60 * 60 * 1000 })
        : Response.json({ error: "signed_out" }, { status: 401 });
    }
    if (path.endsWith("/api/auth/logout")) {
      signedIn = false;
      return new Response(null, { status: 204 });
    }
    return undefined;
  }

  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input, location.href);
    const answer =
      url.origin === location.origin
        ? relay(url.pathname)
        : url.origin === "https://api.github.com"
          ? github(url.pathname)
          : undefined;
    return answer ?? realFetch(input, init);
  };

  // The sign-in link leads to the relay, which the demo doesn't have.
  document.addEventListener("click", (event) => {
    const link = event.target instanceof Element ? event.target.closest("a") : null;
    if (link?.getAttribute("href") === "api/auth/login") {
      event.preventDefault();
      signedIn = true;
      options.onSignIn();
    }
  });
}

/** The sample answer to a call to api.github.com, or nothing for a path the demo doesn't stand in for. */
function github(path: string): Response | undefined {
  if (path === "/user") {
    return Response.json({ login: "octocat", avatar_url: AVATARS.octocat });
  }
  return undefined;
}
