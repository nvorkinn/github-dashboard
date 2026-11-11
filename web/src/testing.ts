import { vi } from "vitest";

/** One request the page made, as a fake backend sees it. */
export type Call = { method: string; url: string; headers: Headers };

/**
 * Replaces `fetch` with a fake relay and GitHub for a test. `answer` gets each request, with the relay's addresses
 * shortened to their path (`/api/auth/token`), and what it returns is the response; throwing stands for a network
 * failure. Returns the calls made so far.
 */
export function stubBackend(answer: (call: Call) => Response): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const address = new URL(input instanceof Request ? input.url : input, location.href);
    const call = {
      method: init?.method ?? "GET",
      url: address.origin === location.origin ? address.pathname : address.href,
      headers: new Headers(init?.headers),
    };
    calls.push(call);
    return answer(call);
  });
  return calls;
}

export function tokenAnswer(accessToken: string, lifetimeMs = 8 * 60 * 60 * 1000): Response {
  return Response.json({ access_token: accessToken, expires_at: Date.now() + lifetimeMs });
}
