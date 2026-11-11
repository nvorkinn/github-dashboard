import { expect, test } from "vitest";
import { fakeDashboard, project, pull, ready } from "../components/testing.ts";
import type { MergeMethod, PullRequest } from "../model.ts";
import { ActionError, AUTO_MERGE_OFF, createPullActions, DRAFT_REFUSED } from "./pull_actions.ts";
import { fakeGitHub, type Routes, withPull } from "./testing.ts";

const REPO = "octocat/weather-station";
const PULL = `repos/${REPO}/pulls/1`;

/** Pull request actions on a fake GitHub, with a dashboard that shows one project of these settings. */
function setUp(routes: Routes, settings: { mergeMethod?: MergeMethod; autoMergeAllowed?: boolean } = {}) {
  const github = fakeGitHub(routes);
  const dashboard = fakeDashboard(ready({ projects: [project(settings)] }));
  return { ...github, dashboard, actions: createPullActions(github.auth, dashboard) };
}

/** A GraphQL answer: what GitHub sends with a 200 whether the mutation went through or not. */
const graphql = (errors?: string[]) => () =>
  Response.json(
    errors
      ? { data: null, errors: errors.map((message) => ({ type: "UNPROCESSABLE", message })) }
      : { data: { mutation: { clientMutationId: null } } },
  );

const writes = (requests: { method: string }[]) => requests.filter((request) => request.method !== "GET");

test("turning auto-merge on asks GitHub's GraphQL API, with the pull request's id and the repository's method", async () => {
  const { actions, requests, dashboard } = setUp({ "POST graphql": graphql() }, { mergeMethod: "squash" });
  await expect(actions.setAutoMerge(pull({ nodeId: "PR_abc" }), true)).resolves.toEqual({ merged: false });
  expect(requests).toEqual([
    {
      method: "POST",
      path: "graphql",
      body: {
        query: expect.stringContaining("enablePullRequestAutoMerge"),
        variables: { id: "PR_abc", method: "SQUASH" },
      },
    },
  ]);
  expect(dashboard.changed).toHaveBeenCalledWith({ kind: "pull_request", repo: REPO, pull: 1 });
});

test("turning auto-merge off needs only the pull request's id", async () => {
  const { actions, requests } = setUp({ "POST graphql": graphql() });
  await expect(actions.setAutoMerge(pull({ nodeId: "PR_abc", autoMerge: true }), false)).resolves.toEqual({
    merged: false,
  });
  expect(requests).toEqual([
    {
      method: "POST",
      path: "graphql",
      body: { query: expect.stringContaining("disablePullRequestAutoMerge"), variables: { id: "PR_abc" } },
    },
  ]);
});

test("each merge method has GraphQL's name", async () => {
  for (const [method, name] of [
    ["merge", "MERGE"],
    ["squash", "SQUASH"],
    ["rebase", "REBASE"],
  ] as const) {
    const { actions, requests } = setUp({ "POST graphql": graphql() }, { mergeMethod: method });
    await actions.setAutoMerge(pull(), true);
    expect(requests[0]?.body).toMatchObject({ variables: { method: name } });
  }
});

test("a pull request of a project the page doesn't show is merged with a merge commit", async () => {
  const { actions, requests } = setUp({ "POST graphql": graphql() });
  await actions.setAutoMerge(pull({ repo: "someone/else" }), true);
  expect(requests[0]?.body).toMatchObject({ variables: { method: "MERGE" } });
});

test("auto-merge isn't turned on for a draft, or where the repository doesn't allow it, and GitHub isn't asked", async () => {
  const draft = setUp({ "POST graphql": graphql() });
  await expect(draft.actions.setAutoMerge(pull({ draft: true }), true)).rejects.toThrow(DRAFT_REFUSED);
  // Turning it off a draft is fine.
  await expect(draft.actions.setAutoMerge(pull({ draft: true, autoMerge: true }), false)).resolves.toBeDefined();
  expect(draft.requests).toHaveLength(1);

  const off = setUp({ "POST graphql": graphql() }, { autoMergeAllowed: false });
  await expect(off.actions.setAutoMerge(pull(), true)).rejects.toThrow(AUTO_MERGE_OFF);
  expect(off.requests).toEqual([]);
  expect(off.dashboard.changed).not.toHaveBeenCalled();
});

test("GitHub refusing auto-merge says GitHub's reason", async () => {
  const { actions, dashboard } = setUp({ "POST graphql": graphql(["Pull request is in unstable status"]) });
  const failed = actions.setAutoMerge(pull(), true);
  await expect(failed).rejects.toBeInstanceOf(ActionError);
  await expect(failed).rejects.toThrow("GitHub refused: Pull request is in unstable status.");
  expect(dashboard.changed).not.toHaveBeenCalled();
});

/** A GitHub where turning auto-merge on is refused, as the base branch requires nothing; the pull request's head is now `sha1`. */
function cleanStatus(checkRuns: unknown[], pullFields: Record<string, unknown> = {}): Routes {
  const routes: Routes = {
    "POST graphql": graphql(["Pull request Pull request is in clean status"]),
    [`PUT ${PULL}/merge`]: { sha: "merged", merged: true, message: "Pull Request successfully merged" },
    [`repos/${REPO}/pulls`]: [],
  };
  withPull(routes, REPO, 1, { pull: pullFields, checkRuns });
  return routes;
}

const passedRun = { name: "test", status: "completed", conclusion: "success", html_url: null };

test("when the base branch requires nothing, auto-merge merges now: at the head whose checks all passed", async () => {
  const { actions, requests, dashboard } = setUp(cleanStatus([passedRun]), { mergeMethod: "rebase" });
  // The page still shows an older head; the merge is of the one whose checks were just read.
  await expect(actions.setAutoMerge(pull({ sha: "old" }), true)).resolves.toEqual({ merged: true });
  expect(writes(requests)).toEqual([
    expect.objectContaining({ method: "POST", path: "graphql" }),
    { method: "PUT", path: `${PULL}/merge`, body: { merge_method: "rebase", sha: "sha1" } },
  ]);
  expect(requests.map((request) => request.path)).toContain(
    `repos/${REPO}/commits/sha1/check-runs?filter=latest&per_page=100`,
  );
  expect(dashboard.changed).toHaveBeenCalledWith({ kind: "push", repo: REPO });
});

test.each([
  ["running", { status: "in_progress", conclusion: null }],
  ["failed", { status: "completed", conclusion: "failure" }],
  ["queued", { status: "queued", conclusion: null }],
])("when the base branch requires nothing, a pull request with a check %s isn't merged", async (_, run) => {
  const { actions, requests } = setUp(cleanStatus([passedRun, { ...passedRun, name: "other", ...run }]));
  await expect(actions.setAutoMerge(pull(), true)).rejects.toThrow(
    "main requires no checks, so GitHub can't wait for them. Try again once this pull request's checks pass.",
  );
  expect(writes(requests).map((request) => request.method)).toEqual(["POST"]);
});

test("when the base branch requires nothing, a pull request that closed meanwhile isn't merged", async () => {
  const { actions, requests } = setUp(cleanStatus([passedRun], { state: "closed" }));
  await expect(actions.setAutoMerge(pull(), true)).rejects.toThrow("This pull request is no longer open.");
  expect(writes(requests)).toHaveLength(1);
});

test("merging merges the head the page showed, with the repository's method", async () => {
  const { actions, requests, dashboard } = setUp(
    { [`PUT ${PULL}/merge`]: { merged: true } },
    { mergeMethod: "squash" },
  );
  await actions.merge(pull({ sha: "abc1234" }));
  expect(requests).toEqual([
    { method: "PUT", path: `${PULL}/merge`, body: { merge_method: "squash", sha: "abc1234" } },
  ]);
  // Its base moved, so the repository's pull requests are all read again.
  expect(dashboard.changed).toHaveBeenCalledWith({ kind: "push", repo: REPO });
});

test("a merge GitHub refuses says GitHub's reason, and is not tried again", async () => {
  const { actions, requests, dashboard } = setUp({
    [`PUT ${PULL}/merge`]: () =>
      Response.json({ message: "Head branch was modified. Review and try the merge again." }, { status: 409 }),
  });
  await expect(actions.merge(pull())).rejects.toThrow(
    "GitHub refused: Head branch was modified. Review and try the merge again.",
  );
  expect(requests).toHaveLength(1);
  expect(dashboard.changed).not.toHaveBeenCalled();
});

test("updating the branch names the head the page showed", async () => {
  const { actions, requests, dashboard } = setUp({
    [`PUT ${PULL}/update-branch`]: () =>
      Response.json({ message: "Updating pull request branch.", url: "https://github.com/" }, { status: 202 }),
  });
  await actions.updateBranch(pull({ sha: "abc1234" }));
  expect(requests).toEqual([{ method: "PUT", path: `${PULL}/update-branch`, body: { expected_head_sha: "abc1234" } }]);
  expect(dashboard.changed).toHaveBeenCalledWith({ kind: "pull_request", repo: REPO, pull: 1 });
});

test.each<[string, () => Response | Promise<Response>, string]>([
  [
    "its own message",
    () => Response.json({ message: "expected head sha didn't match current head ref." }, { status: 422 }),
    "GitHub refused: expected head sha didn't match current head ref.",
  ],
  ["its status, without a message", () => new Response("", { status: 422 }), "GitHub refused (422)."],
  [
    "the permission, when the app hasn't got it",
    () => Response.json({ message: "Resource not accessible by integration" }, { status: 403 }),
    "The GitHub App isn't allowed to do this. It needs Pull requests and Contents with write access.",
  ],
  [
    "the rate limit",
    () =>
      new Response("", {
        status: 403,
        headers: {
          "x-ratelimit-remaining": "0",
          "x-ratelimit-reset": String(Date.parse("2026-11-11T15:30:00") / 1000),
        },
      }),
    "GitHub's rate limit is used up. Trying again at 15:30.",
  ],
  [
    "a sign-in GitHub no longer accepts",
    () => new Response("", { status: 401 }),
    "GitHub no longer accepts the sign-in.",
  ],
  ["GitHub's trouble", () => new Response("", { status: 502 }), "GitHub is having trouble (502)."],
  [
    "a network that fails",
    () => {
      throw new TypeError("Failed to fetch");
    },
    "GitHub couldn't be reached.",
  ],
])("a refusal says %s, in words for the user", async (_, answer, words) => {
  const { actions } = setUp({ [`PUT ${PULL}/update-branch`]: answer });
  const failed = actions.updateBranch(pull() as PullRequest);
  await expect(failed).rejects.toBeInstanceOf(ActionError);
  await expect(failed).rejects.toThrow(words);
});
