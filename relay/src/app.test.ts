import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { createApp } from "./app.ts";

const staticRoot = mkdtempSync(join(tmpdir(), "relay-static-"));
writeFileSync(join(staticRoot, "index.html"), "<!doctype html><title>page</title>");
const app = createApp({ staticRoot });

test("/healthz answers ok", async () => {
  const response = await app.request("/healthz");
  expect(response.status).toBe(200);
  expect(await response.text()).toBe("ok");
});

test("serves the built page with a strict content security policy", async () => {
  const response = await app.request("/");
  expect(response.status).toBe(200);
  expect(await response.text()).toContain("<title>page</title>");
  const csp = response.headers.get("content-security-policy") ?? "";
  expect(csp).toContain("default-src 'self'");
  expect(csp).toContain("connect-src 'self' https://api.github.com");
  expect(csp).toContain("frame-ancestors 'none'");
});
