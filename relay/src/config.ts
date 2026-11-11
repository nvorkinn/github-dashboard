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

/** Where the Telegram notices go (see README.md, "Telegram"). */
export type TelegramConfig = {
  /** The bot's token from BotFather, `<digits>:<letters>`. It is a secret: it never goes into a log. */
  botToken: string;
  /** The chat the bot writes to: a number (negative for a group) or a channel's `@name`. */
  chatId: string;
};

const TELEGRAM_NAMES = ["TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID"] as const;
const BOT_TOKEN = /^\d+:[A-Za-z0-9_-]+$/;
const CHAT_ID = /^(-?\d+|@[A-Za-z0-9_]{5,32})$/;

/**
 * Reads the Telegram settings. They are optional: with neither set no notices are sent. One without the other, or
 * either in the wrong form, is a mistake and throws, so the relay refuses to start. The error never quotes the token.
 */
export function readTelegramConfig(env: Record<string, string | undefined>): TelegramConfig | undefined {
  const missing = TELEGRAM_NAMES.filter((name) => !env[name]);
  if (missing.length === TELEGRAM_NAMES.length) {
    return undefined;
  }
  if (missing.length > 0) {
    throw new Error(`Telegram is half configured: ${missing.join(", ")} not set`);
  }
  const botToken = env.TELEGRAM_BOT_TOKEN ?? "";
  const chatId = env.TELEGRAM_CHAT_ID ?? "";
  if (!BOT_TOKEN.test(botToken)) {
    throw new Error("TELEGRAM_BOT_TOKEN must be a bot token as BotFather gives it, <digits>:<letters>");
  }
  if (!CHAT_ID.test(chatId)) {
    throw new Error("TELEGRAM_CHAT_ID must be a chat's number, such as 123456789, or a channel's @name");
  }
  return { botToken, chatId };
}
