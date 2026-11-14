import { createVerify, generateKeyPairSync } from "node:crypto";
import { afterEach, expect, test, vi } from "vitest";
import { AppError, createGitHubApp, reasonOf } from "./github_app.ts";

const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const privateKey = keys.privateKey.export({ type: "pkcs1", format: "pem" }).toString();
const config = { appId: "123456", privateKey };
const NOW = Date.parse("2026-11-14T12:00:00Z");

afterEach(() => {
  vi.restoreAllMocks();
});

/** A fake api.github.com: `answers` by method and path, a number being a status. Tokens are numbered as given. */
function fakeGitHub(answers: Record<string, unknown>) {
  const calls: { key: string; authorization: string }[] = [];
  let tokens = 0;
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    const { pathname, search } = new URL(String(url));
    const key = `${init?.method} ${pathname.slice(1)}${search}`;
    calls.push({ key, authorization: new Headers(init?.headers).get("Authorization") ?? "" });
    if (/access_tokens$/.test(pathname) && !Object.hasOwn(answers, key)) {
      tokens++;
      return Response.json({ token: `ghs_SECRET${tokens}`, expires_at: new Date(NOW + 3_600_000).toISOString() });
    }
    const found = Object.hasOwn(answers, key) ? answers[key] : 404;
    return typeof found === "number" ? new Response("may quote the request", { status: found }) : Response.json(found);
  }) as typeof fetch;
  return { fetcher, calls, keys: () => calls.map((call) => call.key) };
}

test("signs in as the app with a short-lived token made from its key", async () => {
  const github = fakeGitHub({ "GET app/installations?per_page=100&page=1": [] });
  const app = createGitHubApp({ config, fetch: github.fetcher, now: () => NOW });
  expect(await app.repositories()).toEqual([]);

  const [, jwt = ""] = github.calls[0]?.authorization.split(" ") ?? [];
  const [header = "", payload = "", signature = ""] = jwt.split(".");
  expect(JSON.parse(Buffer.from(header, "base64url").toString())).toEqual({ alg: "RS256", typ: "JWT" });
  expect(JSON.parse(Buffer.from(payload, "base64url").toString())).toEqual({
    iat: NOW / 1000 - 60,
    exp: NOW / 1000 + 540,
    iss: "123456",
  });
  const verify = createVerify("RSA-SHA256").update(`${header}.${payload}`);
  expect(verify.verify(keys.publicKey, signature, "base64url")).toBe(true);
});

test("lists the repositories of every installation that isn't suspended, archived ones left out", async () => {
  const github = fakeGitHub({
    "GET app/installations?per_page=100&page=1": [
      { id: 1 },
      { id: 2, suspended_at: "2026-01-01T00:00:00Z" },
      { id: 3 },
    ],
    "GET installation/repositories?per_page=100&page=1": {
      repositories: [
        { full_name: "nvorkinn/a", default_branch: "main" },
        { full_name: "nvorkinn/old", default_branch: "main", archived: true },
      ],
    },
  });
  const app = createGitHubApp({ config, fetch: github.fetcher, now: () => NOW });
  // Both installations answer the same here, each asked with its own token.
  expect(await app.repositories()).toEqual([
    { repo: "nvorkinn/a", installation: 1, defaultBranch: "main" },
    { repo: "nvorkinn/a", installation: 3, defaultBranch: "main" },
  ]);
  expect(github.keys()).not.toContain("POST app/installations/2/access_tokens");
  const reads = github.calls.filter((call) => call.key.startsWith("GET installation/"));
  expect(reads.map((call) => call.authorization)).toEqual(["Bearer ghs_SECRET1", "Bearer ghs_SECRET2"]);
});

test("keeps an installation's token until shortly before it ends, and asks once for reads side by side", async () => {
  let now = NOW;
  const github = fakeGitHub({ "GET repos/o/r": { ok: true } });
  const app = createGitHubApp({ config, fetch: github.fetcher, now: () => now });
  await Promise.all([app.get(7, "repos/o/r"), app.get(7, "repos/o/r")]);
  await app.get(7, "repos/o/r");
  expect(github.keys().filter((key) => key.startsWith("POST"))).toEqual(["POST app/installations/7/access_tokens"]);

  now = NOW + 56 * 60_000;
  await app.get(7, "repos/o/r");
  expect(github.keys().filter((key) => key.startsWith("POST"))).toHaveLength(2);
  expect(github.calls.at(-1)?.authorization).toBe("Bearer ghs_SECRET2");
});

test("a token GitHub no longer takes is replaced once", async () => {
  const answers: Record<string, unknown> = { "GET repos/o/r": 401 };
  const github = fakeGitHub(answers);
  const app = createGitHubApp({ config, fetch: github.fetcher, now: () => NOW });
  await expect(app.get(7, "repos/o/r")).rejects.toMatchObject({ status: 401 });
  expect(github.keys().filter((key) => key.startsWith("POST"))).toHaveLength(2);
});

test("reads every page of a list", async () => {
  const page = (from: number, count: number) => Array.from({ length: count }, (_, index) => ({ id: from + index }));
  const github = fakeGitHub({
    "GET repos/o/r/actions/runs/1/jobs?per_page=100&page=1": { jobs: page(0, 100) },
    "GET repos/o/r/actions/runs/1/jobs?per_page=100&page=2": { jobs: page(100, 3) },
  });
  const app = createGitHubApp({ config, fetch: github.fetcher, now: () => NOW });
  expect(await app.list(7, "repos/o/r/actions/runs/1/jobs", "jobs")).toHaveLength(103);
  await expect(app.list(7, "repos/o/r", "jobs")).rejects.toBeInstanceOf(AppError);
});

test("a failure says its status or kind, and nothing of the token, the key or the answer", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const github = fakeGitHub({ "GET repos/o/r": 403 });
  const app = createGitHubApp({ config, fetch: github.fetcher, now: () => NOW });
  const refused = await app.get(7, "repos/o/r").catch((error: unknown) => error);
  expect(reasonOf(refused)).toBe("HTTP 403");

  const down = createGitHubApp({
    config,
    fetch: (async () => {
      throw new TypeError(`fetch failed for a URL with ghs_SECRET and ${privateKey}`);
    }) as typeof fetch,
  });
  const failed = await down.get(7, "repos/o/r").catch((error: unknown) => error);
  expect(reasonOf(failed)).toBe("TypeError");
  expect(String(failed)).not.toContain("SECRET");
  expect(warn).not.toHaveBeenCalled();
});
