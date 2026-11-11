import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createApp } from "./app.ts";
import { FRESH_ENOUGH_MS } from "./auth.ts";
import type { AuthConfig } from "./config.ts";
import { codeChallenge, open, seal } from "./crypto.ts";

const config: AuthConfig = {
  clientId: "Iv1.client",
  clientSecret: "client-secret",
  cookieKey: randomBytes(32),
  publicOrigin: "https://github.vorkinn.org",
  secureCookies: true,
};
const staticRoot = mkdtempSync(join(tmpdir(), "relay-static-"));
const sameOrigin = { "Sec-Fetch-Site": "same-origin" };

/** GitHub's answer to a code exchange or a refresh. */
function grant(name: string): Response {
  return Response.json({
    access_token: `ghu_${name}`,
    expires_in: 28800,
    refresh_token: `ghr_${name}`,
    refresh_token_expires_in: 15897600,
    token_type: "bearer",
    scope: "",
  });
}

function appWith(github: typeof fetch) {
  return createApp({ staticRoot, auth: config, fetch: github });
}

/** The Set-Cookie header for one cookie, or nothing. */
function setCookie(response: Response, name: string): string | undefined {
  return response.headers.getSetCookie().find((cookie) => cookie.startsWith(`${name}=`));
}

function refreshCookie(refreshToken: string): string {
  return `refresh=${seal(config.cookieKey, "refresh", refreshToken)}`;
}

/** What the fake GitHub was sent in its only call. */
function sent(github: ReturnType<typeof vi.fn>): { url: unknown; init: RequestInit; form: URLSearchParams } {
  expect(github).toHaveBeenCalledOnce();
  const [url, init] = github.mock.calls[0] as [unknown, RequestInit];
  return { url, init, form: new URLSearchParams(init.body as string) };
}

let warnings: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  warnings = vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  // No log line may carry a secret, whatever went wrong.
  for (const line of warnings.mock.calls.flat().map(String)) {
    expect(line).not.toMatch(/gh[ur]_|client-secret|the-code/);
  }
  vi.restoreAllMocks();
});

test("login sends the browser to GitHub with a state it also keeps in a cookie", async () => {
  const response = await appWith(vi.fn()).request("/api/auth/login");
  expect(response.status).toBe(302);

  const location = new URL(response.headers.get("location") ?? "");
  expect(location.origin + location.pathname).toBe("https://github.com/login/oauth/authorize");
  expect(location.searchParams.get("client_id")).toBe("Iv1.client");
  expect(location.searchParams.get("redirect_uri")).toBe("https://github.vorkinn.org/api/auth/callback");
  const state = location.searchParams.get("state") ?? "";
  expect(state.length).toBeGreaterThanOrEqual(32);

  const cookie = setCookie(response, "signin_state") ?? "";
  expect(cookie).toContain(`signin_state=${state}.`);
  // The cookie also keeps the PKCE verifier whose challenge went to GitHub.
  const verifier = cookie.slice(cookie.indexOf(".") + 1, cookie.indexOf(";"));
  expect(verifier).toHaveLength(43);
  expect(location.searchParams.get("code_challenge")).toBe(codeChallenge(verifier));
  expect(location.searchParams.get("code_challenge_method")).toBe("S256");
  expect(cookie).toContain("Max-Age=600");
  expect(cookie).toContain("Path=/api/auth");
  expect(cookie).toContain("HttpOnly");
  expect(cookie).toContain("Secure");
  expect(cookie).toContain("SameSite=Lax");
});

test("the callback trades the code for tokens, keeps the refresh token in its cookie and goes to the page", async () => {
  const github = vi.fn().mockResolvedValue(grant("first"));
  const response = await appWith(github).request("/api/auth/callback?code=the-code&state=abc", {
    headers: { Cookie: "signin_state=abc.the-verifier" },
  });

  expect(response.status).toBe(302);
  // No token in the address: the page asks for it once loaded.
  expect(response.headers.get("location")).toBe("/");
  expect(response.headers.get("cache-control")).toBe("no-store");

  const { url, init, form } = sent(github);
  expect(url).toBe("https://github.com/login/oauth/access_token");
  expect(new Headers(init.headers).get("accept")).toBe("application/json");
  expect(Object.fromEntries(form)).toEqual({
    client_id: "Iv1.client",
    client_secret: "client-secret",
    code: "the-code",
    code_verifier: "the-verifier",
    redirect_uri: "https://github.vorkinn.org/api/auth/callback",
  });

  const cookie = setCookie(response, "refresh") ?? "";
  expect(cookie).not.toContain("ghr_first");
  expect(open(config.cookieKey, "refresh", cookie.slice("refresh=".length, cookie.indexOf(";")))).toBe("ghr_first");
  expect(cookie).toContain("Max-Age=15897600");
  expect(cookie).toContain("Path=/api/auth");
  expect(cookie).toContain("HttpOnly");
  expect(cookie).toContain("Secure");
  expect(cookie).toContain("SameSite=Strict");
  // The access token waits in a cookie of its own for the page to ask for it, for as long as it lasts.
  const access = setCookie(response, "access") ?? "";
  expect(access).not.toContain("ghu_first");
  expect(
    JSON.parse(open(config.cookieKey, "access", access.slice("access=".length, access.indexOf(";"))) ?? ""),
  ).toEqual({ token: "ghu_first", expiresAt: expect.any(Number) });
  expect(access).toMatch(/Max-Age=28(800|799)/);
  expect(access).toContain("Path=/api/auth");
  expect(access).toContain("HttpOnly");
  expect(access).toContain("Secure");
  expect(access).toContain("SameSite=Strict");
  // The state is used up.
  expect(setCookie(response, "signin_state")).toContain("Max-Age=0");
});

function accessCookie(token: string, expiresAt: number, key = config.cookieKey): string {
  return `access=${seal(key, "access", JSON.stringify({ token, expiresAt }))}`;
}

test("token hands out the access token in its cookie again while it lasts, without asking GitHub", async () => {
  const github = vi.fn();
  const expiresAt = Date.now() + 3 * 3600_000;
  const response = await appWith(github).request("/api/auth/token", {
    method: "POST",
    headers: { ...sameOrigin, Cookie: `${refreshCookie("ghr_first")}; ${accessCookie("ghu_kept", expiresAt)}` },
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ access_token: "ghu_kept", expires_at: expiresAt });
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(github).not.toHaveBeenCalled();
  // The cookies stay as they are.
  expect(response.headers.getSetCookie()).toEqual([]);
});

test.each([
  ["has little time left", () => accessCookie("ghu_kept", Date.now() + FRESH_ENOUGH_MS - 1000), ""],
  ["was sealed with another key", () => accessCookie("ghu_kept", Date.now() + 3600_000, randomBytes(32)), ""],
  ["isn't one of ours", () => "access=bm90IG91cnM", ""],
  ["is the refresh token's, moved", () => `access=${seal(config.cookieKey, "refresh", "ghr_first")}`, ""],
  ["is fine, but the page asks for a fresh one", () => accessCookie("ghu_kept", Date.now() + 3600_000), "?fresh=1"],
])("token refreshes at GitHub when the access token in the cookie %s", async (_, cookie, query) => {
  const github = vi.fn().mockResolvedValue(grant("second"));
  const response = await appWith(github).request(`/api/auth/token${query}`, {
    method: "POST",
    headers: { ...sameOrigin, Cookie: `${refreshCookie("ghr_first")}; ${cookie()}` },
  });
  expect(((await response.json()) as { access_token: string }).access_token).toBe("ghu_second");
  expect(github).toHaveBeenCalledOnce();
  const access = setCookie(response, "access") ?? "";
  expect(open(config.cookieKey, "access", access.slice("access=".length, access.indexOf(";")))).toContain("ghu_second");
});

test("an access token in its cookie is no sign-in without the refresh token's", async () => {
  const github = vi.fn();
  const response = await appWith(github).request("/api/auth/token", {
    method: "POST",
    headers: { ...sameOrigin, Cookie: accessCookie("ghu_kept", Date.now() + 3600_000) },
  });
  expect(response.status).toBe(401);
  expect(setCookie(response, "access")).toContain("Max-Age=0");
  expect(github).not.toHaveBeenCalled();
});

test("cookies aren't marked Secure when the public address is plain http", async () => {
  const app = createApp({
    staticRoot,
    auth: { ...config, publicOrigin: "http://localhost:5173", secureCookies: false },
    fetch: vi.fn(),
  });
  const response = await app.request("/api/auth/login");
  expect(setCookie(response, "signin_state")).not.toContain("Secure");
});

test.each([
  ["a state that doesn't match", "/api/auth/callback?code=the-code&state=other", "signin_state=abc.the-verifier"],
  ["no state cookie", "/api/auth/callback?code=the-code&state=abc", ""],
  ["a state cookie without a verifier", "/api/auth/callback?code=the-code&state=abc", "signin_state=abc"],
  ["no state in the address", "/api/auth/callback?code=the-code", "signin_state=abc.the-verifier"],
  ["a refusal by the user", "/api/auth/callback?error=access_denied&state=abc", "signin_state=abc.the-verifier"],
  ["no code", "/api/auth/callback?state=abc", "signin_state=abc.the-verifier"],
])("the callback fails on %s without asking GitHub", async (_, path, cookie) => {
  const github = vi.fn();
  const response = await appWith(github).request(path, { headers: { Cookie: cookie } });
  expect(response.status).toBe(302);
  expect(response.headers.get("location")).toBe("/?signin=failed");
  expect(setCookie(response, "refresh")).toBeUndefined();
  expect(github).not.toHaveBeenCalled();
  expect(warnings).toHaveBeenCalledOnce();
});

test.each([
  ["refuses the code", () => Promise.resolve(Response.json({ error: "bad_verification_code" }))],
  ["answers with an error", () => Promise.resolve(new Response("oops", { status: 500 }))],
  ["can't be reached", () => Promise.reject(new TypeError("fetch failed"))],
  ["sends a token that never expires", () => Promise.resolve(Response.json({ access_token: "ghu_forever" }))],
])("the callback fails when GitHub %s", async (_, answer) => {
  const response = await appWith(vi.fn(answer)).request("/api/auth/callback?code=the-code&state=abc", {
    headers: { Cookie: "signin_state=abc.the-verifier" },
  });
  expect(response.headers.get("location")).toBe("/?signin=failed");
  expect(setCookie(response, "refresh")).toBeUndefined();
  expect(warnings).toHaveBeenCalledOnce();
});

test("token refreshes at GitHub, hands out the access token and replaces the cookie", async () => {
  const github = vi.fn().mockResolvedValue(grant("second"));
  const before = Date.now();
  const response = await appWith(github).request("/api/auth/token", {
    method: "POST",
    headers: { ...sameOrigin, Cookie: refreshCookie("ghr_first") },
  });

  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  const body = (await response.json()) as { access_token: string; expires_at: number };
  expect(body.access_token).toBe("ghu_second");
  expect(body.expires_at).toBeGreaterThanOrEqual(before + 28800_000);
  expect(body.expires_at).toBeLessThanOrEqual(Date.now() + 28800_000);
  expect(Object.keys(body)).toEqual(["access_token", "expires_at"]);

  expect(Object.fromEntries(sent(github).form)).toEqual({
    client_id: "Iv1.client",
    client_secret: "client-secret",
    grant_type: "refresh_token",
    refresh_token: "ghr_first",
  });

  // The old refresh token is used up, so the cookie now holds the new one.
  const cookie = setCookie(response, "refresh") ?? "";
  expect(open(config.cookieKey, "refresh", cookie.slice("refresh=".length, cookie.indexOf(";")))).toBe("ghr_second");
  expect(cookie).toContain("SameSite=Strict");
});

test.each([
  ["no cookie", ""],
  ["a cookie that doesn't decrypt", "refresh=bm90IG91cnM"],
  ["a cookie sealed with another key", `refresh=${seal(randomBytes(32), "refresh", "ghr_first")}`],
])("token answers 401 and clears the cookie on %s", async (_, cookie) => {
  const github = vi.fn();
  const response = await appWith(github).request("/api/auth/token", {
    method: "POST",
    headers: { ...sameOrigin, Cookie: cookie },
  });
  expect(response.status).toBe(401);
  expect(setCookie(response, "refresh")).toContain("Max-Age=0");
  expect(github).not.toHaveBeenCalled();
});

test("token answers 401 and clears the cookie when GitHub no longer takes the refresh token", async () => {
  const github = vi.fn().mockResolvedValue(Response.json({ error: "bad_refresh_token" }));
  const response = await appWith(github).request("/api/auth/token", {
    method: "POST",
    headers: { ...sameOrigin, Cookie: refreshCookie("ghr_old") },
  });
  expect(response.status).toBe(401);
  const cookie = setCookie(response, "refresh") ?? "";
  expect(cookie).toContain("Max-Age=0");
  expect(cookie).toContain("Path=/api/auth");
});

test.each([
  ["answers with an error", () => Promise.resolve(new Response("oops", { status: 503 }))],
  ["can't be reached", () => Promise.reject(new TypeError("fetch failed"))],
  ["answers with something that isn't JSON", () => Promise.resolve(new Response("<html>"))],
  ["refuses the relay itself", () => Promise.resolve(Response.json({ error: "incorrect_client_credentials" }))],
])("token answers 502 and keeps the cookie when GitHub %s", async (_, answer) => {
  const response = await appWith(vi.fn(answer)).request("/api/auth/token", {
    method: "POST",
    headers: { ...sameOrigin, Cookie: refreshCookie("ghr_first") },
  });
  expect(response.status).toBe(502);
  expect(response.headers.getSetCookie()).toEqual([]);
  expect(warnings).toHaveBeenCalledOnce();
});

test("refreshes arriving together with the same cookie make one call to GitHub", async () => {
  let answer: (response: Response) => void = () => {};
  const github = vi.fn(() => new Promise<Response>((resolve) => (answer = resolve)));
  const app = appWith(github);
  const request = { method: "POST", headers: { ...sameOrigin, Cookie: refreshCookie("ghr_first") } };

  const both = Promise.all([app.request("/api/auth/token", request), app.request("/api/auth/token", request)]);
  await vi.waitFor(() => expect(github).toHaveBeenCalled());
  answer(grant("second"));

  for (const response of await both) {
    expect(response.status).toBe(200);
    expect(((await response.json()) as { access_token: string }).access_token).toBe("ghu_second");
    expect(setCookie(response, "refresh")).toBeDefined();
  }
  expect(github).toHaveBeenCalledOnce();

  // Nothing is kept once it settles: the next refresh asks GitHub again.
  github.mockResolvedValue(grant("third"));
  await app.request("/api/auth/token", request);
  expect(github).toHaveBeenCalledTimes(2);
});

test("logout clears the cookies", async () => {
  const response = await appWith(vi.fn()).request("/api/auth/logout", {
    method: "POST",
    headers: { ...sameOrigin, Cookie: refreshCookie("ghr_first") },
  });
  expect(response.status).toBe(204);
  const cookie = setCookie(response, "refresh") ?? "";
  expect(cookie).toContain("refresh=;");
  expect(cookie).toContain("Max-Age=0");
  expect(cookie).toContain("Path=/api/auth");
  const access = setCookie(response, "access") ?? "";
  expect(access).toContain("access=;");
  expect(access).toContain("Max-Age=0");
  expect(access).toContain("Path=/api/auth");
});

test.each([
  ["another site, as the browser reports it", { "Sec-Fetch-Site": "cross-site", Origin: "https://github.vorkinn.org" }],
  ["a sibling site", { "Sec-Fetch-Site": "same-site" }],
  ["another origin", { Origin: "https://evil.example" }],
  ["nowhere in particular", {}],
] as [string, Record<string, string>][])("a POST from %s is refused", async (_, headers) => {
  const github = vi.fn();
  for (const path of ["/api/auth/token", "/api/auth/logout"]) {
    const response = await appWith(github).request(path, {
      method: "POST",
      headers: { ...headers, Cookie: refreshCookie("ghr_first") },
    });
    expect(response.status, path).toBe(403);
    expect(response.headers.getSetCookie()).toEqual([]);
  }
  expect(github).not.toHaveBeenCalled();
});

test("a POST from a browser without Sec-Fetch-Site passes on its Origin", async () => {
  const response = await appWith(vi.fn()).request("/api/auth/logout", {
    method: "POST",
    headers: { Origin: "https://github.vorkinn.org" },
  });
  expect(response.status).toBe(204);
});

test("without configuration the sign-in endpoints answer 503 and the rest still works", async () => {
  const app = createApp({ staticRoot });
  for (const [method, path] of [
    ["GET", "/api/auth/login"],
    ["GET", "/api/auth/callback?code=the-code&state=abc"],
    ["POST", "/api/auth/token"],
    ["POST", "/api/auth/logout"],
  ] as const) {
    const response = await app.request(path, { method, headers: sameOrigin });
    expect(response.status, path).toBe(503);
    expect(await response.text()).toContain("not configured");
  }
  expect((await app.request("/healthz")).status).toBe(200);
});
