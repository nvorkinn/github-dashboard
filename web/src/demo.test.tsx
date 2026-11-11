// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/preact";
import { afterEach, expect, test, vi } from "vitest";
import { App } from "./App.tsx";
import { createAuth } from "./auth.ts";
import { createDemoDashboard, demoPullActions, demoRunActions } from "./demo/dashboard.ts";
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
  const { unmount } = render(<App auth={auth} dashboard={createDemoDashboard()} demo />);

  // The sample user also wrote some of the sample pull requests; this is the one in the header.
  const account = { selector: ".login" };
  expect(await screen.findByText("octocat", account)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
  fireEvent.click(await screen.findByRole("link", { name: "Sign in with GitHub" }));
  expect(await screen.findByText("octocat", account)).toBeTruthy();
  expect(network).not.toHaveBeenCalled();
  // Stops the demo's script.
  unmount();
});

test("the page on the demo shows the sample dashboard", async () => {
  globalThis.fetch = vi.fn();
  const auth = createAuth();
  installDemo({ onSignIn: () => void auth.start() });
  const { unmount } = render(<App auth={auth} dashboard={createDemoDashboard()} demo />);

  expect(await screen.findByText("Show wind gusts on the hourly chart")).toBeTruthy();
  expect(screen.getByText("Bump vite from 8.3.6 to 8.3.7")).toBeTruthy();
  expect(screen.getByRole("link", { name: "v2.5.0" })).toBeTruthy();
  expect(screen.getByText("no release yet")).toBeTruthy();
  expect(screen.getByText("Private")).toBeTruthy();
  expect(screen.getByText("Live")).toBeTruthy();
  unmount();
});

test("the page on the demo can act on its pull requests, and shows one action failing", async () => {
  globalThis.fetch = vi.fn();
  const auth = createAuth();
  installDemo({ onSignIn: () => void auth.start() });
  const dashboard = createDemoDashboard({ show: "offline" });
  const pulls = demoPullActions(dashboard);
  const { unmount } = render(<App auth={auth} dashboard={dashboard} actions={pulls ? { pulls } : {}} demo />);

  const row = (title: string) => {
    const item = screen.getByText(title, { exact: false }).closest("li");
    if (!item) {
      throw new Error(`No row for ${title}`);
    }
    return within(item);
  };
  await screen.findByText("Add a README");
  fireEvent.click(row("Add a README").getByRole("button", { name: "Auto-merge" }));
  expect(row("Add a README").getByRole("button", { name: "Turning on…" })).toBeTruthy();
  expect((await row("Add a README").findByRole("alert", {}, { timeout: 3000 })).textContent).toContain(
    "Auto-merge is off for this repository",
  );

  fireEvent.click(row("Rework the elevation profile").getByRole("button", { name: "Update branch" }));
  await waitFor(() => expect(row("Rework the elevation profile").queryByText("Behind base")).toBeNull(), {
    timeout: 3000,
  });
  expect(row("Rework the elevation profile").getByText("Running", { selector: "summary .chip" })).toBeTruthy();
  unmount();
});

test("the page on the demo can show that it is reconnecting", async () => {
  globalThis.fetch = vi.fn();
  const auth = createAuth();
  installDemo({ onSignIn: () => void auth.start() });
  const { unmount } = render(<App auth={auth} dashboard={createDemoDashboard({ show: "offline" })} demo />);

  expect(await screen.findByText("Reconnecting")).toBeTruthy();
  expect(screen.getByText("Show wind gusts on the hourly chart")).toBeTruthy();
  expect(screen.queryByRole("alert")).toBeNull();
  unmount();
});

test("the page on the demo has actions that work on the sample data, and one that fails", async () => {
  globalThis.fetch = vi.fn();
  const auth = createAuth();
  installDemo({ onSignIn: () => void auth.start() });
  const dashboard = createDemoDashboard({ show: "offline" });
  // What makeActions gives a demo build, which this test is not.
  const runs = demoRunActions(dashboard);
  const actions = runs ? { runs } : {};
  const { unmount } = render(<App auth={auth} dashboard={dashboard} actions={actions} demo />);

  fireEvent.click(await screen.findByRole("button", { name: "Approve production" }));
  fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
  expect(screen.getByRole("button", { name: "Approving…" })).toBeTruthy();
  // The run moves on, so it waits for nothing anymore and its buttons go.
  await waitFor(() => expect(screen.queryByRole("button", { name: "Approving…" })).toBeNull(), { timeout: 3000 });
  expect(screen.queryByRole("button", { name: "Approve production" })).toBeNull();
  expect(screen.queryByText("Waiting for approval", { selector: ".chip" })).toBeNull();

  expect(screen.getByRole("button", { name: "Re-run failed jobs" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Promote home-ledger v1.12.3" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Release garden-sensors" }));
  expect((await screen.findByRole("alert", {}, { timeout: 3000 })).textContent).toBe(
    "Tag v3.1.0 already exists. Resolve it on GitHub before releasing.",
  );
  unmount();
});
