import type { Auth } from "../auth.ts";
import type { Dashboard, PullRequest } from "../model.ts";
import { type Api, createApi } from "./api.ts";
import { pullRequest } from "./read.ts";
import { ActionError, send, worded } from "./writes.ts";

export type ReviewInfo = {
  pull: PullRequest;
  description: string;
  canApprove: boolean;
  canMerge: boolean;
  reviews: { user: { login: string } | null; state: string; body: string }[];
  /** What GitHub groups each check run under, by its address (see `Check.workflow`). Unset when not asked. */
  workflows?: Record<string, string>;
};
export type ReviewService = {
  read(pull: PullRequest): Promise<ReviewInfo>;
  approve(pull: PullRequest): Promise<void>;
};
export function createReviewService(auth: Auth, dashboard: Dashboard): ReviewService {
  const api = createApi(auth);
  return {
    async read(pull) {
      const path = `repos/${pull.repo}/pulls/${pull.number}`;
      const [fresh, detail, repo, viewer, reviews, workflows] = await Promise.all([
        pullRequest(api, pull.repo, pull.number),
        api.get<{ body: string | null }>(path),
        api.get<{ permissions?: { push?: boolean } }>(`repos/${pull.repo}`),
        api.get<{ login: string }>("user"),
        api.list<ReviewInfo["reviews"][number]>(`${path}/reviews`),
        workflowsOf(api, pull),
      ]);
      if (!fresh) throw new Error("This pull request is no longer open.");
      return {
        pull: fresh,
        description: detail.body ?? "",
        reviews,
        workflows,
        canApprove: !fresh.draft && viewer.login !== fresh.author,
        canMerge: repo.permissions?.push === true && !fresh.draft && fresh.mergeState === "clean",
      };
    },
    approve: (pull) =>
      worded(async () => {
        const fresh = await pullRequest(api, pull.repo, pull.number);
        if (!fresh || fresh.sha !== pull.sha)
          throw new ActionError("This pull request changed. Refresh before approving.");
        await send(
          auth,
          `repos/${pull.repo}/pulls/${pull.number}/reviews`,
          "POST",
          {
            event: "APPROVE",
            commit_id: pull.sha,
          },
          "Pull requests",
        );
        dashboard.changed({ kind: "pull_request", repo: pull.repo, pull: pull.number });
      }),
  };
}

type RawRun = { name: string | null; check_suite_id: number };
type RawSuiteCheck = { html_url: string | null; check_suite: { id: number } | null; app: { name: string } | null };

/**
 * The workflow each check run of the pull request's head belongs to, or the app that ran it when no workflow did, by
 * the check run's address. Only the review asks this, once as it opens: the dashboard's own read leaves workflows to
 * the relay. Nothing, when GitHub won't say (no Actions permission, say): the checks are then shown ungrouped.
 */
async function workflowsOf(api: Api, pull: PullRequest): Promise<Record<string, string>> {
  try {
    const [runs, checks] = await Promise.all([
      api.list<RawRun>(`repos/${pull.repo}/actions/runs?head_sha=${pull.sha}`, "workflow_runs"),
      api.list<RawSuiteCheck>(`repos/${pull.repo}/commits/${pull.sha}/check-runs?filter=latest`, "check_runs"),
    ]);
    const bySuite = new Map(runs.map((run) => [run.check_suite_id, run.name ?? undefined]));
    const found: Record<string, string> = {};
    for (const check of checks) {
      const workflow = (check.check_suite && bySuite.get(check.check_suite.id)) ?? check.app?.name;
      if (check.html_url && workflow) found[check.html_url] = workflow;
    }
    return found;
  } catch {
    return {};
  }
}
