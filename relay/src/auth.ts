import type { Context } from "hono";
import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { AuthConfig } from "./config.ts";
import { codeChallenge, open, randomToken, sameString, seal } from "./crypto.ts";
import type { Grant, GrantResult } from "./github_oauth.ts";
import { authorizeUrl, errorCode, exchangeCode, refreshGrant } from "./github_oauth.ts";

// Both cookies go only to the sign-in endpoints, never with the page or its files.
const COOKIE_PATH = "/api/auth";
const REFRESH_COOKIE = "refresh";
const STATE_COOKIE = "signin_state";
const STATE_SECONDS = 600;

/**
 * The sign-in endpoints, mounted at /api/auth. They do the two things the browser can't, because both need the
 * GitHub App's client secret and GitHub's token endpoint doesn't allow cross-origin calls: trading the sign-in code
 * for tokens, and refreshing them.
 *
 * The access token goes to the page and is never kept here. The refresh token lives in an encrypted cookie that
 * scripts can't read, so the relay stores nothing. There is no list of allowed users: the reverse proxy decides who
 * reaches the relay at all.
 */
export function authRoutes(options: { config: AuthConfig | undefined; fetch: typeof fetch }) {
  const routes = new Hono();
  const { config } = options;

  if (!config) {
    routes.all("/*", (c) =>
      c.text(
        "Sign-in is not configured: set GITHUB_APP_CLIENT_ID, GITHUB_APP_CLIENT_SECRET, COOKIE_KEY and PUBLIC_URL",
        503,
      ),
    );
    return routes;
  }

  // Refreshes under way, by the cookie that asked. The refresh token works once, so two tabs refreshing at the same
  // moment must share one call to GitHub. An entry goes as soon as its call settles; nothing is remembered.
  const refreshing = new Map<string, Promise<GrantResult>>();

  const refreshCookie = {
    path: COOKIE_PATH,
    httpOnly: true,
    secure: config.secureCookies,
    sameSite: "Strict",
  } as const;
  // Lax, not Strict: the callback is reached by a redirect from github.com and needs this cookie.
  const stateCookie = { path: COOKIE_PATH, httpOnly: true, secure: config.secureCookies, sameSite: "Lax" } as const;

  const keepRefreshToken = (c: Context, grant: Grant) => {
    setCookie(c, REFRESH_COOKIE, seal(config.cookieKey, REFRESH_COOKIE, grant.refreshToken), {
      ...refreshCookie,
      maxAge: grant.refreshTokenSeconds,
    });
  };

  routes.use("/*", async (c, next) => {
    // Answers here depend on who asks and carry tokens: no cache may keep them.
    c.header("Cache-Control", "no-store");
    if (c.req.method === "POST" && !sameOrigin(c, config.publicOrigin)) {
      return c.text("Cross-site request refused", 403);
    }
    return next();
  });

  routes.get("/login", (c) => {
    // GitHub hands the state back to the callback, which proves the sign-in was started from this browser. The
    // verifier (PKCE) proves to GitHub that the code is redeemed by whoever started it. Both wait in one cookie.
    const state = randomToken();
    const verifier = randomToken();
    setCookie(c, STATE_COOKIE, `${state}.${verifier}`, { ...stateCookie, maxAge: STATE_SECONDS });
    return c.redirect(authorizeUrl(config, state, codeChallenge(verifier)));
  });

  routes.get("/callback", async (c) => {
    const [expected, verifier] = (getCookie(c, STATE_COOKIE) ?? "").split(".");
    deleteCookie(c, STATE_COOKIE, stateCookie);

    // The reason goes to the log only; the address bar just learns that it failed.
    const fail = (reason: string) => {
      console.warn(`sign-in failed: ${reason}`);
      return c.redirect("/?signin=failed");
    };

    const state = c.req.query("state");
    if (!expected || !verifier || !state || !sameString(state, expected)) {
      return fail("the state doesn't match the one this browser started with");
    }
    const error = c.req.query("error");
    if (error) {
      return fail(`GitHub sent back ${errorCode(error)}`);
    }
    const code = c.req.query("code");
    if (!code) {
      return fail("no code in the callback");
    }

    const result = await exchangeCode(options.fetch, config, code, verifier);
    if (!result.ok) {
      return fail(`code exchange ${result.kind}: ${result.reason}`);
    }
    // Only the refresh token is kept, in its cookie. The page asks /token for an access token once it has loaded.
    keepRefreshToken(c, result.grant);
    return c.redirect("/");
  });

  routes.post("/token", async (c) => {
    const signedOut = () => {
      deleteCookie(c, REFRESH_COOKIE, refreshCookie);
      return c.json({ error: "signed_out" }, 401);
    };

    const cookie = getCookie(c, REFRESH_COOKIE);
    const refreshToken = cookie && open(config.cookieKey, REFRESH_COOKIE, cookie);
    if (!cookie || !refreshToken) {
      return signedOut();
    }

    let pending = refreshing.get(cookie);
    if (!pending) {
      pending = refreshGrant(options.fetch, config, refreshToken).finally(() => refreshing.delete(cookie));
      refreshing.set(cookie, pending);
    }
    const result = await pending;

    if (result.ok) {
      keepRefreshToken(c, result.grant);
      return c.json({ access_token: result.grant.accessToken, expires_at: result.grant.expiresAt });
    }
    if (result.kind === "refused" && result.reason === "bad_refresh_token") {
      // Expired, revoked or already used: only signing in again helps.
      return signedOut();
    }
    // Anything else says nothing about the user (GitHub down, a wrong client secret), so the cookie stays for the
    // next try.
    console.warn(`token refresh ${result.kind}: ${result.reason}`);
    return c.json({ error: "github_unavailable" }, 502);
  });

  routes.post("/logout", (c) => {
    deleteCookie(c, REFRESH_COOKIE, refreshCookie);
    return c.body(null, 204);
  });

  return routes;
}

/**
 * Whether a request comes from the page itself. Browsers say so in Sec-Fetch-Site; one that doesn't send it must
 * show the page's own Origin. (The refresh cookie being SameSite=Strict is the second lock.)
 */
function sameOrigin(c: Context, publicOrigin: string): boolean {
  const site = c.req.header("Sec-Fetch-Site");
  if (site !== undefined) {
    return site === "same-origin";
  }
  return c.req.header("Origin") === publicOrigin;
}
