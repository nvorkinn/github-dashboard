import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { secureHeaders } from "hono/secure-headers";

/**
 * The relay: serves the built page and, in later steps, the GitHub App sign-in, the token refresh and the webhook to
 * push channel. It keeps no database and stores no tokens.
 */
export function createApp(options: { staticRoot: string }) {
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

  app.use("/*", serveStatic({ root: options.staticRoot }));

  return app;
}
