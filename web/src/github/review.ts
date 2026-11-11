import type { Auth } from "../auth.ts";
import type { Dashboard, PullRequest } from "../model.ts";
import { createApi } from "./api.ts";
import { pullRequest } from "./read.ts";
import { ActionError, send, worded } from "./writes.ts";

export type ReviewInfo = {
  pull: PullRequest;
  description: string;
  canApprove: boolean;
  canMerge: boolean;
  reviews: { user: { login: string } | null; state: string; body: string }[];
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
      const [fresh, detail, repo, viewer, reviews] = await Promise.all([
        pullRequest(api, pull.repo, pull.number),
        api.get<{ body: string | null }>(path),
        api.get<{ permissions?: { push?: boolean } }>(`repos/${pull.repo}`),
        api.get<{ login: string }>("user"),
        api.list<ReviewInfo["reviews"][number]>(`${path}/reviews`),
      ]);
      if (!fresh) throw new Error("This pull request is no longer open.");
      return {
        pull: fresh,
        description: detail.body ?? "",
        reviews,
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
