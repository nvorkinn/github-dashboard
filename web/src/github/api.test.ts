import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createApi, GitHubError, limiter, nextPage } from "./api.ts";
import { fakeGitHub } from "./testing.ts";

const NOW = Date.parse("2026-11-11T12:00:00Z");

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: NOW });
});
afterEach(() => {
  vi.useRealTimers();
});

async function failure(reading: Promise<unknown>): Promise<GitHubError> {
  const error = await reading.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(GitHubError);
  return error as GitHubError;
}

test("reads JSON, asking the browser to revalidate its cached copy", async () => {
  const seen: (RequestInit | undefined)[] = [];
  const { auth } = fakeGitHub({ user: { login: "octocat" } });
  const github = auth.github;
  auth.github = (path, init) => {
    seen.push(init);
    return github(path, init);
  };
  expect(await createApi(auth).get("user")).toEqual({ login: "octocat" });
  expect(seen[0]?.cache).toBe("no-cache");
});

test("a list follows the Link header's next page to the end", async () => {
  const second = "https://api.github.com/repositories/1/pulls?state=open&per_page=100&page=2";
  const third = "https://api.github.com/repositories/1/pulls?state=open&per_page=100&page=3";
  const { auth, calls } = fakeGitHub({
    "repos/octo/app/pulls?state=open&per_page=100": () =>
      Response.json([{ number: 1 }], {
        headers: { link: `<${second}>; rel="next", <${third}>; rel="last"` },
      }),
    [second]: () =>
      Response.json([{ number: 2 }], {
        headers: { link: `<https://api.github.com/x?page=1>; rel="prev", <${third}>; rel="next"` },
      }),
    [third]: () => Response.json([{ number: 3 }], { headers: { link: `<${second}>; rel="prev"` } }),
  });
  expect(await createApi(auth).list("repos/octo/app/pulls?state=open")).toEqual([
    { number: 1 },
    { number: 2 },
    { number: 3 },
  ]);
  expect(calls).toEqual(["repos/octo/app/pulls?state=open&per_page=100", second, third]);
});

test("a list inside an object is read by its key", async () => {
  const { auth, calls } = fakeGitHub({ "user/installations": { total_count: 1, installations: [{ id: 7 }] } });
  expect(await createApi(auth).list("user/installations", "installations")).toEqual([{ id: 7 }]);
  expect(calls).toEqual(["user/installations?per_page=100"]);
});

test("an answer that isn't the list asked for is an error", async () => {
  const { auth } = fakeGitHub({ "user/installations": { message: "odd" } });
  await failure(createApi(auth).list("user/installations", "installations"));
});

test("the next page is only followed on api.github.com, where the token belongs", () => {
  expect(nextPage('<https://api.github.com/user/repos?page=2>; rel="next"')).toBe(
    "https://api.github.com/user/repos?page=2",
  );
  expect(nextPage('<https://example.com/user/repos?page=2>; rel="next"')).toBeUndefined();
  expect(nextPage('<https://api.github.com/user/repos?page=1>; rel="prev"')).toBeUndefined();
  expect(nextPage(null)).toBeUndefined();
});

test("an error carries its status and is no rate limit", async () => {
  const { auth } = fakeGitHub({
    missing: () => Response.json({ message: "Not Found" }, { status: 404 }),
    // A token without the permission, with requests to spare.
    forbidden: () =>
      Response.json(
        { message: "Resource not accessible by integration" },
        { status: 403, headers: { "x-ratelimit-remaining": "4990", "x-ratelimit-reset": "1" } },
      ),
  });
  const api = createApi(auth);
  expect(await failure(api.get("missing"))).toMatchObject({ status: 404, retryAt: undefined });
  expect(await failure(api.get("forbidden"))).toMatchObject({ status: 403, retryAt: undefined });
});

test.each([
  [
    "the hourly limit, until its reset",
    403,
    { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(NOW / 1000 + 900) },
    "",
    NOW + 900_000,
  ],
  ["a secondary limit, for retry-after", 403, { "retry-after": "30" }, "", NOW + 30_000],
  ["a 429 that doesn't say how long, for a minute", 429, {}, "", NOW + 60_000],
  [
    "a 403 that only says so in words, for a minute",
    403,
    {},
    "You have exceeded a secondary rate limit.",
    NOW + 60_000,
  ],
])("a rate limit says when to retry: %s", async (_, status, headers, message, retryAt) => {
  const { auth } = fakeGitHub({ user: () => Response.json({ message }, { status, headers }) });
  expect(await failure(createApi(auth).get("user"))).toMatchObject({ status, retryAt });
});

test("no more requests than the cap are under way at once", async () => {
  const routes: Record<string, unknown> = {};
  const paths = Array.from({ length: 30 }, (_, index) => `item/${index}`);
  for (const path of paths) {
    routes[path] = { path };
  }
  const { auth, peak } = fakeGitHub(routes);
  const api = createApi(auth, { parallel: 3 });
  const read = await Promise.all(paths.map((path) => api.get(path)));
  expect(read).toHaveLength(30);
  expect(peak()).toBe(3);
});

test("the limiter gives a place back when a task fails", async () => {
  const limit = limiter(1);
  await expect(limit(() => Promise.reject(new Error("no")))).rejects.toThrow("no");
  expect(await limit(async () => "next")).toBe("next");
});

test("a stopped read makes no more requests", async () => {
  const { auth, calls } = fakeGitHub({ user: {} });
  const controller = new AbortController();
  controller.abort();
  await expect(createApi(auth, { signal: controller.signal }).get("user")).rejects.toThrow();
  expect(calls).toEqual([]);
});
