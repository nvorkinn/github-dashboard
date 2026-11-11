import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { secureHeaders } from "hono/secure-headers";
import { authRoutes } from "./auth.ts";
import type { AuthConfig } from "./config.ts";

/**
 * The relay: serves the built page, signs in to the GitHub App and refreshes its token (see auth.ts) and, in a later
 * step, passes webhook events on to the page. It keeps no database and stores no tokens.
 *
 * Without `auth` the sign-in endpoints answer 503. `fetch` is how the relay reaches GitHub; tests pass their own.
 */
export function createApp(options: { staticRoot: string; auth?: AuthConfig | undefined; fetch?: typeof fetch }) {
  const app = new Hono();

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

  app.use("/*", serveStatic({ root: options.staticRoot }));

  return app;
}
