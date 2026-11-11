// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/preact";
import { afterEach, expect, test, vi } from "vitest";
import { App } from "./App.tsx";
import { createAuth } from "./auth.ts";
import { installDemo } from "./demo.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
});

test("answers for the relay and for GitHub itself and passes everything else on", async () => {
  const network = vi.fn(async () => new Response("from the network"));
  globalThis.fetch = network;
  installDemo({ onSignIn: () => {} });

  const token = await fetch("api/auth/token", { method: "POST" });
  expect(token.status).toBe(200);
  const { access_token, expires_at } = await token.json();
  expect(access_token).toBe("demo-token");
  expect(expires_at).toBeGreaterThan(Date.now());

  const user = await (await fetch("https://api.github.com/user")).json();
  expect(user.login).toBe("octocat");
  // Drawn into the address, so showing it needs no network.
  expect(user.avatar_url).toMatch(/^data:image\/svg\+xml,/);
  expect(network).not.toHaveBeenCalled();

  expect(await (await fetch("https://api.github.com/somewhere/else")).text()).toBe("from the network");
  expect(await (await fetch("healthz")).text()).toBe("from the network");
  expect(network).toHaveBeenCalledTimes(2);
});

test("is signed out after a sign-out, until the sign-in link is clicked", async () => {
  globalThis.fetch = vi.fn();
  const onSignIn = vi.fn();
  installDemo({ onSignIn });

  expect((await fetch("api/auth/logout", { method: "POST" })).status).toBe(204);
  expect((await fetch("api/auth/token", { method: "POST" })).status).toBe(401);

  const link = document.createElement("a");
  link.href = "api/auth/login";
  document.body.append(link);
  const click = new MouseEvent("click", { bubbles: true, cancelable: true });
  link.dispatchEvent(click);
  link.remove();

  // The link leads to a relay that isn't there, so the demo stays on the page.
  expect(click.defaultPrevented).toBe(true);
  expect(onSignIn).toHaveBeenCalledOnce();
  expect((await fetch("api/auth/token", { method: "POST" })).status).toBe(200);
});

test("the page on the demo shows the sample user and can sign out and in again", async () => {
  const network = vi.fn();
  globalThis.fetch = network;
  const auth = createAuth();
  installDemo({ onSignIn: () => void auth.start() });
  render(<App auth={auth} demo />);

  expect(await screen.findByText("octocat")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
  fireEvent.click(await screen.findByRole("link", { name: "Sign in with GitHub" }));
  expect(await screen.findByText("octocat")).toBeTruthy();
  expect(network).not.toHaveBeenCalled();
});
