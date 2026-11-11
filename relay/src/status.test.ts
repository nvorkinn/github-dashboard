import { expect, test, vi } from "vitest";
import { summaryFixture } from "../../web/src/service_status_fixtures.ts";
import { createApp } from "./app.ts";
import { createStatusCache } from "./status.ts";

test("shares concurrent upstream reads and caches successes and failures for a minute", async () => {
  let now = 1_000;
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => Response.json(summaryFixture()));
  const read = createStatusCache({ fetch: fetcher, now: () => now });
  const [a, b] = await Promise.all([read(), read()]);
  expect(a).toBe(b);
  expect(fetcher).toHaveBeenCalledTimes(1);
  await read();
  expect(fetcher).toHaveBeenCalledTimes(1);
  now += 60_000;
  fetcher.mockRejectedValue(new Error("network"));
  const stale = await read();
  expect(stale).toMatchObject({ data: a.data, fetchedAt: 1_000, stale: true });
  await read();
  expect(fetcher).toHaveBeenCalledTimes(2);
  now += 60_000;
  fetcher.mockResolvedValue(Response.json(summaryFixture()));
  expect(await read()).toMatchObject({ fetchedAt: now, stale: false });
});
test("route returns unavailable without a first success and never caches in the browser", async () => {
  const app = createApp({
    staticRoot: "web",
    fetch: vi.fn().mockResolvedValue(new Response("bad", { status: 502 })),
  });
  const response = await app.request("/api/github/status");
  expect(response.status).toBe(503);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toEqual({ stale: true, error: "Can't refresh GitHub status." });
});
