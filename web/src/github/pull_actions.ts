import type { Auth } from "../auth.ts";
import type { Dashboard, MergeMethod, Project, PullActions, PullRequest } from "../model.ts";
import { summarize } from "../model.ts";
import { createApi } from "./api.ts";
import { pullRequest } from "./read.ts";
import { ActionError, refusedWith, send as sendWrite, worded } from "./writes.ts";

export { ActionError };

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

  /** Sends one write; if GitHub says the app isn't allowed, says which permissions it needs. */
  function send(path: string, method: string, body: unknown): Promise<Response> {
    return sendWrite(auth, path, method, body, "Pull requests and Contents");
  }

  async function mergeAt(pull: PullRequest, sha: string): Promise<void> {
    await send(`repos/${pull.repo}/pulls/${pull.number}/merge`, "PUT", {
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
        const response = await send("graphql", "POST", {
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
        await send(`repos/${pull.repo}/pulls/${pull.number}/update-branch`, "PUT", {
          expected_head_sha: pull.sha,
        });
        // GitHub updates the branch in the background; the push it makes is an event of its own as well.
        dashboard.changed({ kind: "pull_request", repo: pull.repo, pull: pull.number });
      }),
  };
}
