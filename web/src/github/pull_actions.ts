import type { Auth } from "../auth.ts";
import type { Dashboard, MergeMethod, Project, PullActions, PullRequest } from "../model.ts";
import { isDependabot, summarize } from "../model.ts";
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
export const NOT_DEPENDABOT = "Only Dependabot's own pull requests can be asked to rebase.";
/** The comment that asks Dependabot to rebase a pull request of its own. */
export const REBASE_COMMAND = "@dependabot rebase";
export const AUTO_MERGE_OFF = "Auto-merge is off for this repository. Turn on Allow auto-merge in its settings.";

/**
 * The API version that has the asynchronous merge, the only one that merges a stacked pull request. The page's other
 * requests keep their older version.
 */
const ASYNC_MERGE_VERSION = { "X-GitHub-Api-Version": "2026-03-10" };
/** How often, and for how long, the result of an asynchronous merge is asked for before giving up on waiting. */
const MERGE_POLL_MS = 1_000;
const MERGE_WAIT_MS = 90_000;

/** What GitHub answers about an asynchronous merge: the request and its result. */
type AsyncMerge = {
  status?: "pending" | "merged" | "enqueued" | "failed";
  details?: { message?: string; uuid?: string };
};

/**
 * The pull request actions, done from the page as the signed-in user, straight at api.github.com like every read.
 * How a pull request is merged comes from its project in `dashboard`; after each action that went through, the
 * dashboard is told, so it reads the pull request again.
 *
 * A merge always names the head commit the page showed (or, for auto-merge's fallback, the one whose checks were
 * just read), so GitHub refuses it if anything was pushed since: only what was checked is merged.
 */
export function createPullActions(
  auth: Auth,
  dashboard: Dashboard,
  wait: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): PullActions {
  function projectOf(pull: PullRequest): Pick<Project, "mergeMethod" | "autoMergeAllowed"> {
    const state = dashboard.state();
    const found = state.status === "ready" ? state.data.projects.find((one) => one.repo === pull.repo) : undefined;
    return found ?? { mergeMethod: "merge", autoMergeAllowed: true };
  }

  /** Sends one write; if GitHub says the app isn't allowed, says which permissions it needs. */
  function send(path: string, method: string, body: unknown): Promise<Response> {
    return sendWrite(auth, path, method, body, "Pull requests and Contents");
  }

  /**
   * Merges through GitHub's asynchronous merge, which the older endpoint refuses for a stacked pull request, and waits
   * for the result. Of a stacked pull request, every open one under it in its stack merges with it. Always a direct
   * merge, as before, never through a merge queue.
   */
  async function mergeAt(pull: PullRequest, sha: string): Promise<void> {
    const path = `repos/${pull.repo}/pulls/${pull.number}/merge-async`;
    const response = await sendWrite(
      auth,
      path,
      "PUT",
      { merge_method: projectOf(pull).mergeMethod, merge_action: "direct_merge", sha },
      "Pull requests and Contents",
      // 409: a merge of it was already asked for, whose result is followed instead.
      { headers: ASYNC_MERGE_VERSION, answers: [409] },
    );
    let result = (await response.json().catch(() => ({}))) as AsyncMerge;
    const uuid = result.details?.uuid;
    const until = Date.now() + MERGE_WAIT_MS;
    while (result.status === "pending" || (response.status === 409 && result.status === undefined)) {
      if (!uuid) break;
      if (Date.now() > until) {
        throw new ActionError(`GitHub is still merging #${pull.number}. It will show here once it is through.`);
      }
      await wait(MERGE_POLL_MS);
      result = await pollMerge(`${path}/${uuid}`);
    }
    // Its base moved, which can change whether the repository's other pull requests can be merged.
    dashboard.changed({ kind: "push", repo: pull.repo });
    if (result.status !== "merged" && result.status !== "enqueued") {
      throw new ActionError(refusedWith(result.details?.message ?? "the merge didn't go through"));
    }
  }

  /** The result of an asynchronous merge, as it is now. A read, so trouble reaching GitHub is only tried again. */
  async function pollMerge(path: string): Promise<AsyncMerge> {
    try {
      const response = await auth.github(path, { headers: ASYNC_MERGE_VERSION });
      if (response.ok) return (await response.json()) as AsyncMerge;
    } catch {
      // Asked again next time round.
    }
    return { status: "pending" };
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

    requestRebase: (pull) =>
      worded(async () => {
        if (!isDependabot(pull)) {
          throw new ActionError(NOT_DEPENDABOT);
        }
        // A pull request's conversation is its issue's. Dependabot reads the comment and pushes the rebase itself,
        // which comes back as an event of its own; nothing here changes until then.
        await send(`repos/${pull.repo}/issues/${pull.number}/comments`, "POST", { body: REBASE_COMMAND });
      }),

    merged: (pull) =>
      worded(async () => {
        const read = await createApi(auth).get<{ merged?: unknown }>(`repos/${pull.repo}/pulls/${pull.number}`);
        return read.merged === true;
      }),
  };
}
