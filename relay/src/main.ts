import { serve } from "@hono/node-server";
import { createApp } from "./app.ts";
import type { AuthConfig } from "./config.ts";
import { readAuthConfig } from "./config.ts";

const port = Number(process.env.PORT ?? "8080");
const staticRoot = process.env.STATIC_ROOT ?? "dist/web";

let auth: AuthConfig | undefined;
try {
  auth = readAuthConfig(process.env);
} catch (error) {
  // A wrong setting stops the relay here, with the reason and no stack trace.
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}

const server = serve({ fetch: createApp({ staticRoot, auth }).fetch, port }, (info) => {
  console.log(`relay listening on :${info.port}`);
  console.log(auth ? `sign-in set up for ${auth.publicOrigin}` : "sign-in not configured: its endpoints answer 503");
});

// docker stop sends SIGTERM; close cleanly instead of waiting for the kill.
process.on("SIGTERM", () => server.close(() => process.exit(0)));
