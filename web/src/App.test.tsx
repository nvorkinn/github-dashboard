// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/preact";
import { afterEach, expect, test, vi } from "vitest";
import { App } from "./App.tsx";
import { createAuth } from "./auth.ts";
import { fakeDashboard, project, pull, ready } from "./components/testing.ts";
import type { Call } from "./testing.ts";
import { stubBackend, tokenAnswer } from "./testing.ts";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
  history.replaceState(null, "", "/");
});

const signedOut = () => new Response(null, { status: 401 });

/** A relay and a GitHub with one user signed in. */
function signedIn(call: Call): Response {
  switch (call.url) {
    case "/api/auth/token":
      return tokenAnswer("ghu_one");
    case "/api/auth/logout":
      return new Response(null, { status: 204 });
    case "https://api.github.com/user":
      return Response.json({ login: "octocat", avatar_url: "https://avatars.githubusercontent.com/u/583231" });
    default:
      return new Response(null, { status: 404 });
  }
}

test("offers to sign in when signed out", async () => {
  stubBackend(signedOut);
  render(<App dashboard={fakeDashboard()} auth={createAuth()} />);
  const link = await screen.findByRole("link", { name: "Sign in with GitHub" });
  // Relative, so it also works where the page is served from a sub-path.
  expect(link.getAttribute("href")).toBe("api/auth/login");
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.queryByRole("button", { name: "Sign out" })).toBeNull();
});

test("shows who is signed in", async () => {
  stubBackend(signedIn);
  const { container } = render(<App dashboard={fakeDashboard()} auth={createAuth()} />);
  expect(await screen.findByText("octocat")).toBeTruthy();
  expect(container.querySelector("img")?.getAttribute("src")).toBe("https://avatars.githubusercontent.com/u/583231");
  expect(screen.getByRole("button", { name: "Sign out" })).toBeTruthy();
  expect(screen.queryByRole("link", { name: "Sign in with GitHub" })).toBeNull();
});

test("signs out", async () => {
  const calls = stubBackend(signedIn);
  render(<App dashboard={fakeDashboard()} auth={createAuth()} />);
  fireEvent.click(await screen.findByRole("button", { name: "Sign out" }));
  expect(await screen.findByRole("link", { name: "Sign in with GitHub" })).toBeTruthy();
  expect(screen.queryByText("octocat")).toBeNull();
  expect(calls.at(-1)).toMatchObject({ method: "POST", url: "/api/auth/logout" });
});

test("says so when signing out didn't work", async () => {
  stubBackend((call) => (call.url === "/api/auth/logout" ? new Response(null, { status: 502 }) : signedIn(call)));
  render(<App dashboard={fakeDashboard()} auth={createAuth()} />);
  fireEvent.click(await screen.findByRole("button", { name: "Sign out" }));
  expect((await screen.findByRole("alert")).textContent).toContain("Sign-out didn't work");
  expect(await screen.findByText("octocat")).toBeTruthy();
});

test("says that a sign-in failed and offers another try", async () => {
  history.replaceState(null, "", "/?signin=failed");
  stubBackend(signedOut);
  render(<App dashboard={fakeDashboard()} auth={createAuth()} />);
  expect((await screen.findByRole("alert")).textContent).toContain("Sign-in didn't work");
  expect(screen.getByRole("link", { name: "Sign in with GitHub" })).toBeTruthy();
  expect(location.search).toBe("");
});

test("says so when the relay can't be reached", async () => {
  stubBackend(() => {
    throw new TypeError("network");
  });
  render(<App dashboard={fakeDashboard()} auth={createAuth()} />);
  expect((await screen.findByRole("alert")).textContent).toContain("Can't reach the sign-in service");
  expect(screen.queryByRole("link", { name: "Sign in with GitHub" })).toBeNull();
});

test("says so when GitHub doesn't tell who is signed in", async () => {
  stubBackend((call) =>
    call.url === "https://api.github.com/user" ? new Response(null, { status: 500 }) : signedIn(call),
  );
  render(<App dashboard={fakeDashboard()} auth={createAuth()} />);
  expect(await screen.findByText("Couldn't load your GitHub account")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Sign out" })).toBeTruthy();
});

test("says so when it is the demo", async () => {
  stubBackend(signedOut);
  render(<App dashboard={fakeDashboard()} auth={createAuth()} demo />);
  expect(await screen.findByRole("note")).toBeTruthy();
});

test("links a pull request's demo back to the pull request", async () => {
  stubBackend(signedOut);
  const url = "https://github.com/nvorkinn/github-dashboard/pull/14";
  render(<App dashboard={fakeDashboard()} auth={createAuth()} demo pull={{ number: 14, title: "Link demos", url }} />);
  const link = await screen.findByRole("link", { name: "#14 Link demos" });
  expect(link.getAttribute("href")).toBe(url);
  expect(link.getAttribute("target")).toBe("_blank");
});

test("starts the dashboard once signed in, and not before", async () => {
  stubBackend(signedOut);
  const dashboard = fakeDashboard();
  render(<App auth={createAuth()} dashboard={dashboard} />);
  await screen.findByRole("link", { name: "Sign in with GitHub" });
  expect(dashboard.start).not.toHaveBeenCalled();
  expect(screen.queryByRole("button", { name: "Refresh" })).toBeNull();
  cleanup();

  stubBackend(signedIn);
  render(<App auth={createAuth()} dashboard={dashboard} />);
  expect(await screen.findByText("Loading your projects…")).toBeTruthy();
  await waitFor(() => expect(dashboard.start).toHaveBeenCalledOnce());
  expect(dashboard.stop).not.toHaveBeenCalled();
});

test("stops the dashboard on sign-out", async () => {
  stubBackend(signedIn);
  const dashboard = fakeDashboard(ready({ pulls: [pull({ title: "Somebody's work" })] }));
  render(<App auth={createAuth()} dashboard={dashboard} />);
  expect(await screen.findByText("Somebody's work")).toBeTruthy();

  fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
  await screen.findByRole("link", { name: "Sign in with GitHub" });
  await waitFor(() => expect(dashboard.stop).toHaveBeenCalledOnce());
  expect(screen.queryByText("Somebody's work")).toBeNull();
});

test("stops the dashboard when the page goes away", async () => {
  stubBackend(signedIn);
  const dashboard = fakeDashboard();
  const { unmount } = render(<App auth={createAuth()} dashboard={dashboard} />);
  await screen.findByText("Loading your projects…");
  await waitFor(() => expect(dashboard.start).toHaveBeenCalledOnce());
  unmount();
  await waitFor(() => expect(dashboard.stop).toHaveBeenCalledOnce());
});

test("draws what the dashboard has, as it changes", async () => {
  stubBackend(signedIn);
  const dashboard = fakeDashboard();
  render(<App auth={createAuth()} dashboard={dashboard} />);
  await screen.findByText("Loading your projects…");

  dashboard.set(ready({ pulls: [pull({ title: "First" })] }));
  expect(await screen.findByText("First")).toBeTruthy();
  expect(screen.getByText(/^updated/, { selector: ".updated" })).toBeTruthy();

  dashboard.set(ready({ pulls: [pull({ title: "Second" })] }, { problem: "GitHub didn't answer." }));
  expect(await screen.findByText("Second")).toBeTruthy();
  expect(screen.getByRole("alert").textContent).toBe("GitHub didn't answer.");

  dashboard.set({ status: "failed", problem: "Not connected yet." });
  expect(await screen.findByText("Not connected yet.")).toBeTruthy();
});

test("the Refresh button reads again and shows it", async () => {
  stubBackend(signedIn);
  const dashboard = fakeDashboard(ready());
  let finish = () => {};
  dashboard.refresh.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  render(<App auth={createAuth()} dashboard={dashboard} />);
  fireEvent.click(await screen.findByRole("button", { name: "Refresh" }));
  expect(dashboard.refresh).toHaveBeenCalledOnce();
  expect(await screen.findByRole("button", { name: "Refreshing…" })).toBeTruthy();
  finish();
  expect(await screen.findByRole("button", { name: "Refresh" })).toBeTruthy();
});

test("the actions it is given reach the pull requests, and without them there are no buttons", async () => {
  stubBackend(signedIn);
  const dashboard = fakeDashboard(ready({ pulls: [pull({ title: "Ready one" })] }));
  const pulls = { setAutoMerge: vi.fn(), merge: vi.fn(), updateBranch: vi.fn(async () => {}) };
  render(<App auth={createAuth()} dashboard={dashboard} actions={{ pulls }} />);
  fireEvent.click(await screen.findByRole("button", { name: "Merge" }));
  fireEvent.click(screen.getByRole("button", { name: "Confirm merge" }));
  expect(pulls.merge).toHaveBeenCalledOnce();
  cleanup();

  render(<App auth={createAuth()} dashboard={dashboard} />);
  expect(await screen.findByText("Ready one")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Merge" })).toBeNull();
});

test("the settings page is a link away, and back", async () => {
  stubBackend(signedIn);
  render(<App auth={createAuth()} dashboard={fakeDashboard(ready({ pulls: [pull({ title: "Somebody's work" })] }))} />);
  expect(await screen.findByText("Somebody's work")).toBeTruthy();

  history.replaceState(null, "", "/#settings");
  window.dispatchEvent(new HashChangeEvent("hashchange"));
  expect(await screen.findByRole("heading", { name: "Notifications" })).toBeTruthy();
  expect(screen.queryByText("Somebody's work")).toBeNull();

  history.replaceState(null, "", "/#dashboard");
  window.dispatchEvent(new HashChangeEvent("hashchange"));
  expect(await screen.findByText("Somebody's work")).toBeTruthy();

  // Picking a view from the settings page goes back to the dashboard.
  history.replaceState(null, "", "/#settings");
  window.dispatchEvent(new HashChangeEvent("hashchange"));
  await screen.findByRole("heading", { name: "Notifications" });
  fireEvent.click(screen.getByRole("button", { name: "Lanes" }));
  window.dispatchEvent(new HashChangeEvent("hashchange"));
  await waitFor(() => expect(screen.queryByRole("heading", { name: "Notifications" })).toBeNull());
  localStorage.clear();
});

test("a notice from the dashboard goes to the notifier while signed in", async () => {
  stubBackend(signedIn);
  const dashboard = fakeDashboard();
  const notifier = { notify: vi.fn(), test: vi.fn() };
  render(<App auth={createAuth()} dashboard={dashboard} notifier={notifier} />);
  await screen.findByText("Loading your projects…");
  await waitFor(() => expect(dashboard.start).toHaveBeenCalledOnce());
  const notice = {
    type: "checks" as const,
    key: "checks:octo/app:1",
    repo: "octo/app",
    headline: "Checks failed in octo/app",
    url: "https://github.com/octo/app/pull/1",
  };
  dashboard.notice(notice);
  expect(notifier.notify).toHaveBeenCalledWith(notice);
});

test("keeps streamed notices in the in-app notification centre", async () => {
  stubBackend(signedIn);
  const dashboard = fakeDashboard(ready());
  const notifier = { notify: vi.fn(), test: vi.fn() };
  render(<App auth={createAuth()} dashboard={dashboard} notifier={notifier} />);
  await waitFor(() => expect(dashboard.start).toHaveBeenCalledOnce());
  const notice = {
    type: "waiting" as const,
    key: "waiting:octo/app:1",
    repo: "octo/app",
    headline: "Production waits for approval",
    url: "https://github.com/octo/app/actions/runs/1",
  };

  dashboard.notice(notice);
  const trigger = await screen.findByRole("button", { name: "Notifications, 1 unread" });
  fireEvent.click(trigger);
  expect(screen.getByRole("dialog", { name: /Notifications/ })).toBeTruthy();
  expect(screen.getByRole("link", { name: notice.headline }).getAttribute("href")).toBe(notice.url);
  await waitFor(() => expect(screen.getByRole("button", { name: "Notifications, 0 unread" })).toBeTruthy());
  fireEvent.click(screen.getByRole("button", { name: "Clear notifications" }));
  expect(screen.getByText("No notifications yet.")).toBeTruthy();
});

test("opens the command palette by keyboard and can enter a repository workspace", async () => {
  stubBackend(signedIn);
  const dashboard = fakeDashboard(ready({ projects: [project()] }));
  render(<App auth={createAuth()} dashboard={dashboard} />);
  await screen.findByRole("button", { name: "Refresh" });
  await waitFor(() => expect(dashboard.start).toHaveBeenCalledOnce());

  fireEvent.keyDown(window, { key: "k", ctrlKey: true });
  const palette = screen.getByRole("dialog", { name: "Command palette" });
  expect(palette).toBeTruthy();
  fireEvent.input(screen.getByRole("searchbox", { name: "Search commands" }), {
    target: { value: "weather-station" },
  });
  fireEvent.click(screen.getByRole("option", { name: "Open weather-station" }));

  expect(await screen.findByRole("heading", { name: "weather-station" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Workspace" }).getAttribute("aria-pressed")).toBe("true");
  expect(screen.queryByRole("dialog", { name: "Command palette" })).toBeNull();
});

test("the header's switch shows the projects as lanes, and back", async () => {
  stubBackend(signedIn);
  const dashboard = fakeDashboard(ready({ pulls: [pull({ title: "First" })], projects: [project()] }));
  render(<App auth={createAuth()} dashboard={dashboard} />);
  expect(await screen.findByRole("heading", { level: 2, name: "Pull requests 1" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Lanes" }));
  expect(screen.queryByRole("heading", { level: 2, name: "Pull requests 1" })).toBeNull();
  expect(screen.getByRole("heading", { name: "weather-station" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Stage" }));
  expect(screen.getByRole("heading", { level: 2, name: "Pull requests 1" })).toBeTruthy();
  localStorage.clear();
});
