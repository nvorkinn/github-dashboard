// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createAuth } from "./auth.ts";
import { stubBackend, tokenAnswer } from "./testing.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  history.replaceState(null, "", "/");
});

test("signed out when the relay has no refresh token for this browser", async () => {
  const calls = stubBackend(() => new Response(null, { status: 401 }));
  const auth = createAuth();
  expect(auth.state()).toEqual({ status: "loading" });
  await auth.start();
  expect(auth.state()).toEqual({ status: "signedOut", failed: false });
  expect(calls).toMatchObject([{ method: "POST", url: "/api/auth/token" }]);
});

test("signed in when the relay hands out a token, which goes to api.github.com", async () => {
  const calls = stubBackend((call) => (call.url === "/api/auth/token" ? tokenAnswer("ghu_one") : Response.json({})));
  const auth = createAuth();
  await auth.start();
  expect(auth.state()).toEqual({ status: "signedIn" });

  await auth.github("user");
  const call = calls.at(-1);
  expect(call?.url).toBe("https://api.github.com/user");
  expect(call?.headers.get("authorization")).toBe("Bearer ghu_one");
  expect(call?.headers.get("accept")).toBe("application/vnd.github+json");
  expect(call?.headers.get("x-github-api-version")).toBe("2022-11-28");
});

test("the token stays out of everything a script could read later", async () => {
  stubBackend(() => tokenAnswer("ghu_one"));
  await createAuth().start();
  expect(JSON.stringify({ ...localStorage })).not.toContain("ghu_one");
  expect(JSON.stringify({ ...sessionStorage })).not.toContain("ghu_one");
  expect(document.cookie).not.toContain("ghu_one");
  expect(document.documentElement.outerHTML).not.toContain("ghu_one");
});

test("a failed sign-in is said once and taken out of the address", async () => {
  history.replaceState(null, "", "/?signin=failed&keep=this");
  stubBackend(() => new Response(null, { status: 401 }));
  const auth = createAuth();
  await auth.start();
  expect(auth.state()).toEqual({ status: "signedOut", failed: true });
  expect(location.search).toBe("?keep=this");
});

test.each([
  ["answers with an error", () => new Response(null, { status: 502 })],
  ["isn't set up for sign-in", () => new Response("not configured", { status: 503 })],
  ["answers with something else", () => new Response("<html>")],
  [
    "can't be reached",
    () => {
      throw new TypeError("network");
    },
  ],
])("unavailable when the relay %s", async (_, answer) => {
  stubBackend(answer);
  const auth = createAuth();
  await auth.start();
  expect(auth.state()).toEqual({ status: "unavailable" });
});

test("asks for a new token a few minutes before the old one runs out", async () => {
  let issued = 0;
  const calls = stubBackend((call) =>
    call.url === "/api/auth/token" ? tokenAnswer(`ghu_${++issued}`, 8 * HOUR) : Response.json({}),
  );
  const auth = createAuth();
  await auth.start();

  await vi.advanceTimersByTimeAsync(8 * HOUR - 6 * MINUTE);
  expect(issued).toBe(1);
  await vi.advanceTimersByTimeAsync(2 * MINUTE);
  expect(issued).toBe(2);

  await auth.github("user");
  expect(calls.at(-1)?.headers.get("authorization")).toBe("Bearer ghu_2");
});

test("keeps a token that still works while the relay is having trouble, and tries again", async () => {
  let relayUp = true;
  let issued = 0;
  stubBackend((call) => {
    if (call.url !== "/api/auth/token") {
      return Response.json({});
    }
    return relayUp ? tokenAnswer(`ghu_${++issued}`, 8 * HOUR) : new Response(null, { status: 502 });
  });
  const auth = createAuth();
  await auth.start();

  relayUp = false;
  await vi.advanceTimersByTimeAsync(8 * HOUR - 4 * MINUTE);
  expect(auth.state()).toEqual({ status: "signedIn" });

  relayUp = true;
  await vi.advanceTimersByTimeAsync(MINUTE);
  expect(issued).toBe(2);
});

test("a 401 from api.github.com gets a new token and one more try", async () => {
  let issued = 0;
  const calls = stubBackend((call) => {
    if (call.url === "/api/auth/token") {
      return tokenAnswer(`ghu_${++issued}`);
    }
    return call.headers.get("authorization") === "Bearer ghu_1"
      ? new Response(null, { status: 401 })
      : Response.json({ login: "octocat" });
  });
  const auth = createAuth();
  await auth.start();

  const response = await auth.github("user");
  expect(response.status).toBe(200);
  expect(calls.map((call) => call.url)).toEqual([
    "/api/auth/token",
    "https://api.github.com/user",
    "/api/auth/token",
    "https://api.github.com/user",
  ]);
});

test("a 401 from api.github.com signs out when the relay has no new token either", async () => {
  let signedIn = true;
  stubBackend((call) => {
    if (call.url === "/api/auth/token") {
      return signedIn ? tokenAnswer("ghu_1") : new Response(null, { status: 401 });
    }
    return new Response(null, { status: 401 });
  });
  const auth = createAuth();
  await auth.start();

  signedIn = false;
  expect((await auth.github("user")).status).toBe(401);
  expect(auth.state()).toEqual({ status: "signedOut", failed: false });
});

test("callers that refresh at the same moment share one request", async () => {
  const calls = stubBackend(() => tokenAnswer("ghu_one"));
  const auth = createAuth();
  await Promise.all([auth.start(), auth.start()]);
  expect(calls).toHaveLength(1);
});

test("signing out tells the relay, forgets the token and stops refreshing", async () => {
  const calls = stubBackend((call) =>
    call.url === "/api/auth/logout" ? new Response(null, { status: 204 }) : tokenAnswer("ghu_one"),
  );
  const auth = createAuth();
  await auth.start();
  const changes = vi.fn();
  auth.subscribe(changes);

  expect(await auth.signOut()).toBe(true);
  expect(auth.state()).toEqual({ status: "signedOut", failed: false });
  expect(changes).toHaveBeenCalledOnce();
  expect(calls.at(-1)).toMatchObject({ method: "POST", url: "/api/auth/logout" });

  await vi.advanceTimersByTimeAsync(24 * HOUR);
  expect(calls).toHaveLength(2);
});

test("stays signed in when the sign-out doesn't reach the relay", async () => {
  stubBackend((call) => {
    if (call.url === "/api/auth/logout") {
      throw new TypeError("network");
    }
    return tokenAnswer("ghu_one");
  });
  const auth = createAuth();
  await auth.start();
  expect(await auth.signOut()).toBe(false);
  expect(auth.state()).toEqual({ status: "signedIn" });
});
