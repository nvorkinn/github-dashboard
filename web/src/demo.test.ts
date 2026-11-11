// @vitest-environment happy-dom
import { afterEach, expect, test, vi } from "vitest";
import { installDemo } from "./demo.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

test("answers the relay's health check itself and passes everything else on", async () => {
  const network = vi.fn().mockResolvedValue(new Response("from the network"));
  globalThis.fetch = network;
  installDemo();

  expect(await (await fetch("healthz")).text()).toBe("ok");
  expect(network).not.toHaveBeenCalled();

  expect(await (await fetch("https://api.github.com/user")).text()).toBe("from the network");
  expect(network).toHaveBeenCalledOnce();
});
