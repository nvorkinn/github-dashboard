import { expect, test, vi } from "vitest";
import type { Auth } from "../auth.ts";
import { project } from "../components/testing.ts";
import type { Dashboard } from "../model.ts";
import { createPendingActions } from "./pending_actions.ts";

function setUp(answer: (path: string, init?: RequestInit) => Response) {
  const calls: { path: string; init?: RequestInit | undefined }[] = [];
  const auth = {
    relay: async (path: string, init?: RequestInit) => {
      calls.push({ path, init });
      return answer(path, init);
    },
  } as unknown as Auth;
  const pendingChanged = vi.fn();
  const actions = createPendingActions(auth, { pendingChanged } as unknown as Dashboard);
  return { actions, calls, pendingChanged };
}

test("setting one up asks the relay with the project and pull requests, and shows its answer at once", async () => {
  const snapshot = { configured: true, pending: [] };
  const { actions, calls, pendingChanged } = setUp(() => Response.json(snapshot));
  await actions?.set(project(), [{ repo: "octocat/lib", number: 2 }]);
  expect(calls[0]?.path).toBe("api/pending");
  expect(calls[0]?.init?.method).toBe("POST");
  expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
    repo: "octocat/weather-station",
    pulls: [{ repo: "octocat/lib", number: 2 }],
  });
  expect(pendingChanged).toHaveBeenCalledWith(snapshot);
});

test("the relay's refusal is said as it is; a proxy's page is not", async () => {
  const { actions } = setUp(() => new Response("lib#2 isn't open any more.", { status: 400 }));
  await expect(actions?.set(project(), [{ repo: "octocat/lib", number: 2 }])).rejects.toThrow(
    "lib#2 isn't open any more.",
  );
  const proxied = setUp(() => new Response("<html>Bad gateway</html>", { status: 502 }));
  await expect(proxied.actions?.cancel({ id: "x" } as never)).rejects.toThrow("The dashboard's server answered 502.");
});

test("without a relay to ask there are no pending release actions", () => {
  expect(createPendingActions({} as Auth, {} as Dashboard)).toBeUndefined();
});
