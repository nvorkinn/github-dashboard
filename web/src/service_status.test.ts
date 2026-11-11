import { afterEach, expect, test, vi } from "vitest";
import { parseServiceSummary } from "../../shared/status.ts";
import { createServiceStatus } from "./service_status.ts";
import { summaryFixture } from "./service_status_fixtures.ts";

afterEach(() => vi.useRealTimers());

test("shares polling across subscribers and stops when the last view unmounts", async () => {
  vi.useFakeTimers();
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async () =>
    Response.json({
      data: parseServiceSummary(summaryFixture()),
      fetchedAt: Date.now(),
      stale: false,
    }),
  );
  const status = createServiceStatus({ fetch: fetcher });
  expect(status.state()).toMatchObject({ loading: true, stale: true });
  const stopA = status.subscribe(() => {});
  const stopB = status.subscribe(() => {});
  await status.refresh();
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(status.state()).toMatchObject({ loading: false, stale: false });
  stopA();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(fetcher).toHaveBeenCalledTimes(2);
  stopB();
  await vi.advanceTimersByTimeAsync(180_000);
  expect(fetcher).toHaveBeenCalledTimes(2);
});

test("a failed refresh retains the last successful status and timestamp", async () => {
  vi.useFakeTimers();
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(
      Response.json({
        data: parseServiceSummary(summaryFixture()),
        fetchedAt: Date.now(),
        stale: false,
      }),
    )
    .mockRejectedValue(new Error("offline"));
  const status = createServiceStatus({ fetch: fetcher });
  const stop = status.subscribe(() => {});
  await status.refresh();
  const previous = status.state();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(status.state()).toMatchObject({
    data: previous.data,
    fetchedAt: previous.fetchedAt,
    stale: true,
    loading: false,
  });
  expect(status.state().error).toBeTruthy();
  stop();
});

test("initial failure stays unknown and retries on the polling interval", async () => {
  vi.useFakeTimers();
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response("unavailable", { status: 503 }));
  const status = createServiceStatus({ fetch: fetcher });
  const stop = status.subscribe(() => {});
  await status.refresh();
  expect(status.state()).toMatchObject({ stale: true, loading: false });
  expect(status.state().data).toBeUndefined();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(fetcher).toHaveBeenCalledTimes(2);
  stop();
});

test("unmount aborts the pending request and remount reads again", async () => {
  vi.useFakeTimers();
  let requestSignal: AbortSignal | undefined;
  const fetcher = vi.fn<typeof fetch>().mockImplementation(
    (_url, init) =>
      new Promise((_resolve, reject) => {
        requestSignal = init?.signal ?? undefined;
        requestSignal?.addEventListener("abort", () => reject(new Error("aborted")));
      }),
  );
  const status = createServiceStatus({ fetch: fetcher });
  const stop = status.subscribe(() => {});
  stop();
  expect(requestSignal?.aborted).toBe(true);
  await status.refresh();
  fetcher.mockResolvedValue(
    Response.json({ data: parseServiceSummary(summaryFixture()), fetchedAt: Date.now(), stale: false }),
  );
  const stopAgain = status.subscribe(() => {});
  await status.refresh();
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(status.state()).toMatchObject({ stale: false, loading: false });
  stopAgain();
});
