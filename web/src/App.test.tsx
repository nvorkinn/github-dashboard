// @vitest-environment happy-dom
import { render, screen } from "@testing-library/preact";
import { afterEach, expect, test, vi } from "vitest";
import { App } from "./App.tsx";

afterEach(() => {
  vi.unstubAllGlobals();
});

test("shows the relay as up when /healthz answers", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("ok")));
  render(<App />);
  expect(await screen.findByText("Relay: up")).toBeTruthy();
});

test("shows the relay as not reachable when the request fails", async () => {
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("network")));
  render(<App />);
  expect(await screen.findByText("Relay: not reachable")).toBeTruthy();
});
