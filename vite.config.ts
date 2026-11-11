import preact from "@preact/preset-vite";
import { defineConfig } from "vitest/config";

// The page lives in web/ and builds into dist/web, which the relay serves. Tests run in happy-dom for the page and in
// plain Node for the relay (see the per-file environment comments).
export default defineConfig({
  root: "web",
  plugins: [preact()],
  build: { outDir: "../dist/web", emptyOutDir: true },
  server: { proxy: { "/api": "http://localhost:8080", "/healthz": "http://localhost:8080" } },
  test: {
    root: ".",
    include: ["web/**/*.test.{ts,tsx}", "relay/**/*.test.ts", "tests/**/*.test.ts"],
    environment: "node",
  },
});
