import type { Auth } from "../auth.ts";
import type { Dashboard, MergeMethod, Project, PullActions, PullRequest } from "../model.ts";
import { summarize } from "../model.ts";
import { createApi, GitHubError, retryAt } from "./api.ts";
import { describe } from "./dashboard.ts";
import { pullRequest } from "./read.ts";

// GraphQL's names for the merge methods.
const GRAPHQL_METHOD: Record<MergeMethod, string> = { merge: "MERGE", squash: "SQUASH", rebase: "REBASE" };

const ENABLE_AUTO_MERGE = `mutation($id: ID!, $method: PullRequestMergeMethod!) {
  enablePullRequestAutoMerge(input: {pullRequestId: $id, mergeMethod: $method}) { clientMutationId }
}`;
const DISABLE_AUTO_MERGE = `mutation($id: ID!) {
  disablePullRequestAutoMerge(input: {pullRequestId: $id}) { clientMutationId }
}`;

// What is said when auto-merge can't be turned on, before asking GitHub.
export const DRAFT_REFUSED = "Mark the pull request ready for review before turning on auto-merge.";
export const AUTO_MERGE_OFF = "Auto-merge is off for this repository. Turn on Allow auto-merge in its settings.";

/** An action that didn't go through. Its message is for the user as it is. */
export class ActionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ActionError";
  }
}

/**
 * The pull request actions, done from the page as the signed-in user, straight at api.github.com like every read.
 * How a pull request is merged comes from its project in `dashboard`; after each action that went through, the
 * dashboard is told, so it reads the pull request again.
 *
 * A merge always names the head commit the page showed (or, for auto-merge's fallback, the one whose checks were
 * just read), so GitHub refuses it if anything was pushed since: only what was checked is merged.
 */
export function createPullActions(auth: Auth, dashboard: Dashboard): PullActions {
  function projectOf(pull: PullRequest): Pick<Project, "mergeMethod" | "autoMergeAllowed"> {
    const state = dashboard.state();
    const found = state.status === "ready" ? state.data.projects.find((one) => one.repo === pull.repo) : undefined;
    return found ?? { mergeMethod: "merge", autoMergeAllowed: true };
  }

  async function mergeAt(pull: PullRequest, sha: string): Promise<void> {
    await send(auth, `repos/${pull.repo}/pulls/${pull.number}/merge`, "PUT", {
      merge_method: projectOf(pull).mergeMethod,
      sha,
    });
    // Its base moved, which can change whether the repository's other pull requests can be merged.
    dashboard.changed({ kind: "push", repo: pull.repo });
  }

  return {
    setAutoMerge: (pull, enabled) =>
      worded(async () => {
        if (enabled && pull.draft) {
          throw new ActionError(DRAFT_REFUSED);
        }
        const { mergeMethod, autoMergeAllowed } = projectOf(pull);
        if (enabled && !autoMergeAllowed) {
          throw new ActionError(AUTO_MERGE_OFF);
        }
        const response = await send(auth, "graphql", "POST", {
          query: enabled ? ENABLE_AUTO_MERGE : DISABLE_AUTO_MERGE,
          variables: enabled ? { id: pull.nodeId, method: GRAPHQL_METHOD[mergeMethod] } : { id: pull.nodeId },
        });
        const body = (await response.json().catch(() => undefined)) as { errors?: { message?: unknown }[] } | undefined;
        const message = String(body?.errors?.[0]?.message ?? "");
        if (!body?.errors?.length) {
          dashboard.changed({ kind: "pull_request", repo: pull.repo, pull: pull.number });
          return { merged: false };
        }
        // GitHub won't wait when the base branch requires nothing ("clean status"), so a pull request whose
        // checks are all through is merged now instead, as auto-merge would have done.
        if (!enabled || !/clean status/i.test(message)) {
          throw new ActionError(refusedWith(message));
        }
        const fresh = await pullRequest(createApi(auth), pull.repo, pull.number);
        if (!fresh) {
          throw new ActionError("This pull request is no longer open.");
        }
        const checks = summarize(fresh.checks);
        if (checks !== "passed" && checks !== "none") {
          throw new ActionError(
            `${fresh.base} requires no checks, so GitHub can't wait for them. Try again once this pull request's checks pass.`,
          );
        }
        await mergeAt(fresh, fresh.sha);
        return { merged: true };
      }),

    merge: (pull) => worded(() => mergeAt(pull, pull.sha)),

    updateBranch: (pull) =>
      worded(async () => {
        await send(auth, `repos/${pull.repo}/pulls/${pull.number}/update-branch`, "PUT", {
          expected_head_sha: pull.sha,
        });
        // GitHub updates the branch in the background; the push it makes is an event of its own as well.
        dashboard.changed({ kind: "pull_request", repo: pull.repo, pull: pull.number });
      }),
  };
}

/** Sends one write. Never tried again on its own: it may have gone through. */
async function send(auth: Auth, path: string, method: string, body: unknown): Promise<Response> {
  const response = await auth.github(path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new ActionError(await refusal(path, response));
  }
  return response;
}

/** Why GitHub didn't take a write, in words for the user: its own message where it gives one. */
async function refusal(path: string, response: Response): Promise<string> {
  const retry = await retryAt(response.clone());
  if (retry !== undefined || response.status === 401 || response.status >= 500) {
    return describe(new GitHubError(path, response.status, retry));
  }
  const body = (await response.json().catch(() => undefined)) as { message?: unknown } | undefined;
  const message = typeof body?.message === "string" ? body.message : "";
  if (response.status === 403 && /not accessible by integration/i.test(message)) {
    return "The GitHub App isn't allowed to do this. It needs Pull requests and Contents with write access.";
  }
  return message ? refusedWith(message) : `GitHub refused (${response.status}).`;
}

function refusedWith(message: string): string {
  const said = message.trim().replace(/\.$/, "");
  return said ? `GitHub refused: ${said}.` : "GitHub refused.";
}

/** Runs an action, making whatever it throws an `ActionError` with words for the user. */
async function worded<T>(action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (error) {
    if (error instanceof ActionError) {
      throw error;
    }
    throw new ActionError(describe(error));
  }
}
