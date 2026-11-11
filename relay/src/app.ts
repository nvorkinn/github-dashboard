import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { secureHeaders } from "hono/secure-headers";
import { authRoutes } from "./auth.ts";
import type { AuthConfig, TelegramConfig } from "./config.ts";
import type { Hub } from "./events.ts";
import { createHub, eventStream } from "./events.ts";
import { createStatusCache } from "./status.ts";
import { telegramNotifier } from "./telegram.ts";
import { webhookRoutes } from "./webhook.ts";

// Often enough that a reverse proxy's idle timeout (60 seconds is a common default) never closes a quiet stream.
const PING_MS = 20_000;

/**
 * The relay: serves the built page, signs in to the GitHub App and refreshes its token (see auth.ts), and passes a
 * minimal notice of each GitHub webhook (see webhook.ts) on to the open pages over Server-Sent Events (see
 * events.ts). It keeps no database, stores no tokens and remembers no events; the one thing it holds on to is which
 * Telegram notices it sent lately, so as not to send them twice (see telegram.ts), and a minute of public GitHub
 * service status (see status.ts).
 *
 * Without `auth` the sign-in endpoints answer 503, and without `webhookSecret` the webhook endpoint does. With
 * `telegram`, webhooks that need attention are also sent to a Telegram chat while no page is open (see telegram.ts),
 * with a link to the page when `auth` gives its address. `fetch` is how the relay reaches GitHub and Telegram; tests
 * pass their own. `hub` carries the changes from the webhook endpoint to the event streams, `pingMs` is how often a
 * stream sends a line to stay open, and `closing` ends every open stream when it fires, so the server can shut down.
 *
 * The relay has no list of who may read the event stream, by design: in production the reverse proxy puts
 * /api/events behind Tinyauth like the page, and leaves /api/github/webhook open for GitHub, whose signature the
 * relay checks.
 */
export function createApp(options: {
  staticRoot: string;
  auth?: AuthConfig | undefined;
  fetch?: typeof fetch;
  webhookSecret?: string | undefined;
  telegram?: TelegramConfig | undefined;
  hub?: Hub;
  pingMs?: number;
  closing?: AbortSignal;
}) {
  const app = new Hono();
  const hub = options.hub ?? createHub();

  // The page only talks to itself and api.github.com, and loads nothing from anywhere else.
  app.use(
    secureHeaders({
      contentSecurityPolicy: {
        defaultSrc: ["'self'"],
        connectSrc: ["'self'", "https://api.github.com"],
        imgSrc: ["'self'", "data:", "https://avatars.githubusercontent.com"],
        styleSrc: ["'self'"],
        scriptSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'none'"],
        frameAncestors: ["'none'"],
        formAction: ["'self'"],
      },
      referrerPolicy: "no-referrer",
    }),
  );

  app.get("/healthz", (c) => c.text("ok"));

  const fetcher = options.fetch ?? fetch;
  const onWebhook = options.telegram
    ? telegramNotifier({ config: options.telegram, hub, dashboard: options.auth?.publicOrigin, fetch: fetcher })
    : undefined;

  const readStatus = createStatusCache({ fetch: fetcher });
  app.get("/api/github/status", async (c) => {
    c.header("Cache-Control", "no-store");
    const snapshot = await readStatus();
    return c.json(snapshot, snapshot.data ? 200 : 503);
  });

  app.route("/api/auth", authRoutes({ config: options.auth, fetch: fetcher }));
  app.route("/api/github", webhookRoutes({ secret: options.webhookSecret, hub, onWebhook }));
  app.get("/api/events", eventStream({ hub, pingMs: options.pingMs ?? PING_MS, closing: options.closing }));

  app.use("/*", serveStatic({ root: options.staticRoot }));

  return app;
}
