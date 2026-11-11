/** What the sign-in needs to know. All of it comes from the environment (see README.md, "Sign-in"). */
export type AuthConfig = {
  clientId: string;
  clientSecret: string;
  /** The 32-byte key that encrypts the refresh-token cookie. */
  cookieKey: Buffer;
  /** Where the browser reaches the relay, such as https://github.vorkinn.org, with no trailing slash. */
  publicOrigin: string;
  /** Cookies are marked Secure whenever the public address is https. */
  secureCookies: boolean;
};

const NAMES = ["GITHUB_APP_CLIENT_ID", "GITHUB_APP_CLIENT_SECRET", "COOKIE_KEY", "PUBLIC_URL"] as const;

/**
 * Reads the sign-in settings. With none of them set the relay still runs, without sign-in (the image's CI check
 * starts it bare), so this returns nothing. A half-set or invalid configuration is a mistake and throws, so the relay
 * refuses to start instead of failing at the first sign-in.
 */
export function readAuthConfig(env: Record<string, string | undefined>): AuthConfig | undefined {
  const missing = NAMES.filter((name) => !env[name]);
  if (missing.length === NAMES.length) {
    return undefined;
  }
  if (missing.length > 0) {
    throw new Error(`Sign-in is half configured: ${missing.join(", ")} not set`);
  }
  const clientId = env.GITHUB_APP_CLIENT_ID ?? "";
  const clientSecret = env.GITHUB_APP_CLIENT_SECRET ?? "";
  const key = env.COOKIE_KEY ?? "";

  const cookieKey = Buffer.from(key, "base64");
  // Buffer.from skips what isn't base64, so compare the round trip to catch a mistyped key.
  if (cookieKey.length !== 32 || cookieKey.toString("base64").replace(/=+$/, "") !== key.replace(/=+$/, "")) {
    throw new Error("COOKIE_KEY must be 32 bytes in base64 (openssl rand -base64 32)");
  }

  let url: URL;
  try {
    url = new URL(env.PUBLIC_URL ?? "");
  } catch {
    throw new Error("PUBLIC_URL is not a URL");
  }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("PUBLIC_URL must be an http(s) address with no path, such as https://github.vorkinn.org");
  }

  return { clientId, clientSecret, cookieKey, publicOrigin: url.origin, secureCookies: url.protocol === "https:" };
}

/**
 * Reads the secret GitHub signs its webhooks with (see README.md, "Push"). It is optional and stands apart from the
 * sign-in settings: without it the relay runs, and its webhook endpoint answers 503.
 */
export function readWebhookSecret(env: Record<string, string | undefined>): string | undefined {
  return env.GITHUB_WEBHOOK_SECRET || undefined;
}
