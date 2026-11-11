// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/preact";
import { afterEach, expect, test, vi } from "vitest";
import { App } from "./App.tsx";
import { createAuth } from "./auth.ts";
import type { Call } from "./testing.ts";
import { stubBackend, tokenAnswer } from "./testing.ts";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
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
  render(<App auth={createAuth()} />);
  const link = await screen.findByRole("link", { name: "Sign in with GitHub" });
  // Relative, so it also works where the page is served from a sub-path.
  expect(link.getAttribute("href")).toBe("api/auth/login");
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.queryByRole("button", { name: "Sign out" })).toBeNull();
});

test("shows who is signed in", async () => {
  stubBackend(signedIn);
  const { container } = render(<App auth={createAuth()} />);
  expect(await screen.findByText("octocat")).toBeTruthy();
  expect(container.querySelector("img")?.getAttribute("src")).toBe("https://avatars.githubusercontent.com/u/583231");
  expect(screen.getByRole("button", { name: "Sign out" })).toBeTruthy();
  expect(screen.queryByRole("link", { name: "Sign in with GitHub" })).toBeNull();
});

test("signs out", async () => {
  const calls = stubBackend(signedIn);
  render(<App auth={createAuth()} />);
  fireEvent.click(await screen.findByRole("button", { name: "Sign out" }));
  expect(await screen.findByRole("link", { name: "Sign in with GitHub" })).toBeTruthy();
  expect(screen.queryByText("octocat")).toBeNull();
  expect(calls.at(-1)).toMatchObject({ method: "POST", url: "/api/auth/logout" });
});

test("says so when signing out didn't work", async () => {
  stubBackend((call) => (call.url === "/api/auth/logout" ? new Response(null, { status: 502 }) : signedIn(call)));
  render(<App auth={createAuth()} />);
  fireEvent.click(await screen.findByRole("button", { name: "Sign out" }));
  expect((await screen.findByRole("alert")).textContent).toContain("Sign-out didn't work");
  expect(await screen.findByText("octocat")).toBeTruthy();
});

test("says that a sign-in failed and offers another try", async () => {
  history.replaceState(null, "", "/?signin=failed");
  stubBackend(signedOut);
  render(<App auth={createAuth()} />);
  expect((await screen.findByRole("alert")).textContent).toContain("Sign-in didn't work");
  expect(screen.getByRole("link", { name: "Sign in with GitHub" })).toBeTruthy();
  expect(location.search).toBe("");
});

test("says so when the relay can't be reached", async () => {
  stubBackend(() => {
    throw new TypeError("network");
  });
  render(<App auth={createAuth()} />);
  expect((await screen.findByRole("alert")).textContent).toContain("Can't reach the sign-in service");
  expect(screen.queryByRole("link", { name: "Sign in with GitHub" })).toBeNull();
});

test("says so when GitHub doesn't tell who is signed in", async () => {
  stubBackend((call) =>
    call.url === "https://api.github.com/user" ? new Response(null, { status: 500 }) : signedIn(call),
  );
  render(<App auth={createAuth()} />);
  expect(await screen.findByText("Couldn't load your GitHub account")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Sign out" })).toBeTruthy();
});

test("says so when it is the demo", async () => {
  stubBackend(signedOut);
  render(<App auth={createAuth()} demo />);
  expect(await screen.findByRole("note")).toBeTruthy();
});
