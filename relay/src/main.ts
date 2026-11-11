import { serve } from "@hono/node-server";
import { createApp } from "./app.ts";

const port = Number(process.env.PORT ?? "8080");
const staticRoot = process.env.STATIC_ROOT ?? "dist/web";

const server = serve({ fetch: createApp({ staticRoot }).fetch, port }, (info) => {
  console.log(`relay listening on :${info.port}`);
});

// docker stop sends SIGTERM; close cleanly instead of waiting for the kill.
process.on("SIGTERM", () => server.close(() => process.exit(0)));
