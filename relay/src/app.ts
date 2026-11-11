import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { secureHeaders } from "hono/secure-headers";
import { authRoutes } from "./auth.ts";
import type { AuthConfig } from "./config.ts";
import type { Hub } from "./events.ts";
import { createHub, eventStream } from "./events.ts";
import { webhookRoutes } from "./webhook.ts";

// Often enough that a reverse proxy's idle timeout (60 seconds is a common default) never closes a quiet stream.
const PING_MS = 20_000;

/**
 * The relay: serves the built page, signs in to the GitHub App and refreshes its token (see auth.ts), and passes a
 * minimal notice of each GitHub webhook (see webhook.ts) on to the open pages over Server-Sent Events (see
 * events.ts). It keeps no database, stores no tokens and remembers no events.
 *
 * Without `auth` the sign-in endpoints answer 503, and without `webhookSecret` the webhook endpoint does. `fetch` is
 * how the relay reaches GitHub; tests pass their own. `hub` carries the changes from the webhook endpoint to the
 * event streams, `pingMs` is how often a stream sends a line to stay open, and `closing` ends every open stream when
 * it fires, so the server can shut down.
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

  app.route("/api/auth", authRoutes({ config: options.auth, fetch: options.fetch ?? fetch }));
  app.route("/api/github", webhookRoutes({ secret: options.webhookSecret, hub }));
  app.get("/api/events", eventStream({ hub, pingMs: options.pingMs ?? PING_MS, closing: options.closing }));

  app.use("/*", serveStatic({ root: options.staticRoot }));

  return app;
}
