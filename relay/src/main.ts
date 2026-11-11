import { serve } from "@hono/node-server";
import { createApp } from "./app.ts";
import type { AuthConfig, TelegramConfig } from "./config.ts";
import { readAuthConfig, readTelegramConfig, readWebhookSecret } from "./config.ts";

const port = Number(process.env.PORT ?? "8080");
const staticRoot = process.env.STATIC_ROOT ?? "dist/web";

let auth: AuthConfig | undefined;
let telegram: TelegramConfig | undefined;
try {
  auth = readAuthConfig(process.env);
  telegram = readTelegramConfig(process.env);
} catch (error) {
  // A wrong setting stops the relay here, with the reason and no stack trace.
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
const webhookSecret = readWebhookSecret(process.env);

// Fires when the relay is asked to stop, and ends the event streams, which would otherwise stay open for good.
const closing = new AbortController();

const app = createApp({ staticRoot, auth, webhookSecret, telegram, closing: closing.signal });
const server = serve({ fetch: app.fetch, port }, (info) => {
  console.log(`relay listening on :${info.port}`);
  console.log(auth ? `sign-in set up for ${auth.publicOrigin}` : "sign-in not configured: its endpoints answer 503");
  console.log(
    webhookSecret
      ? "webhooks set up: changes are pushed to the open pages"
      : "webhooks not configured: /api/github/webhook answers 503 and the event stream stays quiet",
  );
  // Whether it is set up, and never the token.
  console.log(
    !telegram
      ? "telegram not configured: no notices are sent"
      : webhookSecret
        ? "telegram set up: notices are sent while no page is open"
        : "telegram set up, but without webhooks there is nothing to send",
  );
});

// docker stop sends SIGTERM; close cleanly instead of waiting for the kill.
process.on("SIGTERM", () => {
  closing.abort();
  server.close(() => process.exit(0));
  // Requests under way get a moment to finish; whatever still holds a connection after that is cut off.
  setTimeout(() => {
    if ("closeAllConnections" in server) {
      server.closeAllConnections();
    }
  }, 3000).unref();
});
