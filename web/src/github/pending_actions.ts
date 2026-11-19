import { pendingSnapshot } from "../../../shared/pending.ts";
import type { Auth } from "../auth.ts";
import type { Dashboard, PendingActions } from "../model.ts";
import { ActionError } from "./writes.ts";

const PATH = "api/pending";

/**
 * Pending releases, which the relay keeps and publishes (see relay/src/pending_releases.ts). The page asks the relay
 * with the user's own token, which the relay checks with GitHub; what it answers is shown at once.
 */
export function createPendingActions(auth: Auth, dashboard: Dashboard): PendingActions | undefined {
  const relay = auth.relay;
  if (!relay) {
    return undefined;
  }
  const call: NonNullable<Auth["relay"]> = relay;

  async function ask(path: string, init: RequestInit): Promise<void> {
    let response: Response;
    try {
      response = await call(path, init);
    } catch {
      throw new ActionError("The dashboard's server didn't answer. Try again.");
    }
    if (!response.ok) {
      const said = (await response.text().catch(() => "")).trim();
      // The relay's refusals are a sentence for the user; a proxy's error page is not.
      throw new ActionError(
        said && said.length < 300 && !said.startsWith("<")
          ? said
          : `The dashboard's server answered ${response.status}.`,
        response.status,
      );
    }
    const snapshot = pendingSnapshot(await response.json().catch(() => undefined));
    if (snapshot) {
      dashboard.pendingChanged?.(snapshot);
    }
  }

  return {
    set(project, pulls) {
      return ask(PATH, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          repo: project.repo,
          pulls: pulls.map((pull) => ({ repo: pull.repo, number: pull.number })),
        }),
      });
    },
    cancel(pending) {
      return ask(`${PATH}/${encodeURIComponent(pending.id)}`, { method: "DELETE" });
    },
  };
}
