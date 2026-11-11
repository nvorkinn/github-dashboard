import type { AuthConfig } from "./config.ts";

const AUTHORIZE_URL = "https://github.com/login/oauth/authorize";
const TOKEN_URL = "https://github.com/login/oauth/access_token";
const TIMEOUT_MS = 10_000;
// A refresh token lasts six months; used when GitHub's answer doesn't say.
const REFRESH_TOKEN_SECONDS = 15_897_600;

/** What GitHub hands out for a signed-in user. */
export type Grant = {
  accessToken: string;
  /** When the access token stops working, in milliseconds since the epoch. */
  expiresAt: number;
  /** Good for one use: refreshing replaces it. */
  refreshToken: string;
  refreshTokenSeconds: number;
};

/**
 * `refused`: GitHub answered and said no, with its error code (never a secret) in `reason`.
 * `unavailable`: GitHub didn't answer, or not in a way that says anything about the user.
 */
export type GrantResult = { ok: true; grant: Grant } | { ok: false; kind: "refused" | "unavailable"; reason: string };

export function callbackUrl(config: AuthConfig): string {
  return `${config.publicOrigin}/api/auth/callback`;
}

/** Where the browser goes to sign in. `challenge` is the PKCE challenge of the verifier `exchangeCode` will show. */
export function authorizeUrl(config: AuthConfig, state: string, challenge: string): string {
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", callbackUrl(config));
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.href;
}

/** Trades the code GitHub sent to the callback for the user's tokens. */
export function exchangeCode(
  fetcher: typeof fetch,
  config: AuthConfig,
  code: string,
  verifier: string,
): Promise<GrantResult> {
  return requestGrant(fetcher, config, { code, code_verifier: verifier, redirect_uri: callbackUrl(config) });
}

/** Trades a refresh token for new tokens. The old refresh token stops working. */
export function refreshGrant(fetcher: typeof fetch, config: AuthConfig, refreshToken: string): Promise<GrantResult> {
  return requestGrant(fetcher, config, { grant_type: "refresh_token", refresh_token: refreshToken });
}

async function requestGrant(
  fetcher: typeof fetch,
  config: AuthConfig,
  parameters: Record<string, string>,
): Promise<GrantResult> {
  let response: Response;
  let body: unknown;
  try {
    response = await fetcher(TOKEN_URL, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        ...parameters,
      }).toString(),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    body = response.ok ? await response.json() : undefined;
  } catch (error) {
    // Only the kind of failure: a message could quote the request.
    return { ok: false, kind: "unavailable", reason: error instanceof Error ? error.name : "request failed" };
  }
  if (!response.ok) {
    return { ok: false, kind: "unavailable", reason: `HTTP ${response.status}` };
  }
  if (typeof body !== "object" || body === null) {
    return { ok: false, kind: "unavailable", reason: "unexpected answer" };
  }

  // GitHub reports a refusal as a 200 with an `error` code.
  const answer = body as Record<string, unknown>;
  if (typeof answer.error === "string") {
    return { ok: false, kind: "refused", reason: errorCode(answer.error) };
  }
  if (typeof answer.access_token !== "string" || typeof answer.expires_in !== "number") {
    return { ok: false, kind: "unavailable", reason: "unexpected answer" };
  }
  if (typeof answer.refresh_token !== "string") {
    // A token that never expires comes without a refresh token; the relay needs the expiring kind.
    return {
      ok: false,
      kind: "unavailable",
      reason: 'no refresh token: turn on "Expire user authorization tokens" in the GitHub App',
    };
  }
  return {
    ok: true,
    grant: {
      accessToken: answer.access_token,
      expiresAt: Date.now() + answer.expires_in * 1000,
      refreshToken: answer.refresh_token,
      refreshTokenSeconds:
        typeof answer.refresh_token_expires_in === "number" ? answer.refresh_token_expires_in : REFRESH_TOKEN_SECONDS,
    },
  };
}

/** An error code as GitHub writes them (`bad_refresh_token`), cut down so nothing else rides along into a log. */
export function errorCode(value: string): string {
  return value.replace(/[^a-z0-9_]/gi, "").slice(0, 64) || "unknown";
}
