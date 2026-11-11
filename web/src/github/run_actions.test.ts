import { expect, test, vi } from "vitest";
import type { Auth } from "../auth.ts";
import { project, run } from "../components/testing.ts";
import type { Approval, Job } from "../model.ts";
import { PROMOTE_WORKFLOW } from "./read.ts";
import { APPROVED_COMMENT, createRunActions, nextTag, REJECTED_COMMENT } from "./run_actions.ts";
import { describeAction } from "./writes.ts";

type Sent = { method: string; path: string; body: unknown };

/**
 * Run actions on a fake GitHub. `routes` answer by method and path (`GET repos/...`, query left off), with JSON or
 * a function for anything else; anything not there is a 404. `sent` are the requests that changed something.
 */
function setUp(routes: Record<string, unknown>) {
  const asked: Sent[] = [];
  const auth: Auth = {
    state: () => ({ status: "signedIn" }),
    subscribe: () => () => {},
    start: async () => {},
    signOut: async () => true,
    async github(path, init) {
      const method = init?.method ?? "GET";
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      asked.push({ method, path, body });
      const route = routes[`${method} ${path.split("?")[0]}`];
      if (route === undefined) {
        return Response.json({ message: "Not Found" }, { status: 404 });
      }
      return typeof route === "function"
        ? await route()
        : Response.json(route, { status: method === "GET" ? 200 : 201 });
    },
  };
  const dashboard = { changed: vi.fn() };
  return {
    actions: createRunActions(auth, dashboard),
    dashboard,
    asked,
    sent: () => asked.filter((one) => one.method !== "GET"),
  };
}

const REPO = "octocat/weather-station";
const RUN = `repos/${REPO}/actions/runs/1`;
const FILE = ".github/workflows/release.yml";
const WORKFLOWS = `repos/${REPO}/contents/.github/workflows`;
const production: Approval = { environmentId: 70, environment: "production", canApprove: true };
const waitingRun = run({ state: "waiting", finishedAt: undefined, approvals: [production] });
const pending = (canApprove = true) => [
  { environment: { id: 70, name: "production" }, current_user_can_approve: canApprove, wait_timer: 0 },
];

test("approving re-checks the run and its pending deployments, then approves that one environment", async () => {
  const { actions, asked, sent, dashboard } = setUp({
    [`GET ${RUN}`]: { id: 1, name: "Release", path: FILE, status: "waiting", conclusion: null },
    [`GET ${RUN}/pending_deployments`]: pending(),
    [`POST ${RUN}/pending_deployments`]: [{ id: 5 }],
  });
  await actions.review(waitingRun, production, "approved");
  expect(asked.map((one) => `${one.method} ${one.path}`)).toEqual([
    `GET ${RUN}`,
    `GET ${WORKFLOWS}`,
    `GET ${RUN}/pending_deployments?per_page=100`,
    `POST ${RUN}/pending_deployments`,
  ]);
  expect(sent()[0]?.body).toEqual({ environment_ids: [70], state: "approved", comment: APPROVED_COMMENT });
  expect(dashboard.changed).toHaveBeenCalledWith({ kind: "deployment_review", repo: REPO, run: 1 });
});

test("rejecting sends the same with state rejected", async () => {
  const { actions, sent } = setUp({
    [`GET ${RUN}`]: { id: 1, name: "Deploy", path: `${FILE}@refs/heads/main`, status: "in_progress", conclusion: null },
    [`GET ${RUN}/pending_deployments`]: pending(),
    [`POST ${RUN}/pending_deployments`]: [],
  });
  await actions.review(waitingRun, production, "rejected");
  expect(sent()[0]?.body).toEqual({ environment_ids: [70], state: "rejected", comment: REJECTED_COMMENT });
});

test.each([
  [
    "the run finished",
    { status: "completed", name: "Release" },
    pending(),
    "This run has finished, so it no longer waits for an approval. Refresh the dashboard.",
  ],
  [
    "the run is no release",
    { status: "waiting", name: "CI" },
    pending(),
    "Only unfinished runs of release workflows can be approved from this dashboard.",
  ],
  [
    "the run is of a workflow GitHub runs by itself",
    { status: "waiting", name: "pages build and deployment", path: "dynamic/pages/pages-build-deployment" },
    pending(),
    "Only unfinished runs of release workflows can be approved from this dashboard.",
  ],
  [
    "the environment no longer waits",
    { status: "waiting", name: "Release" },
    [],
    "This deployment is no longer waiting for approval. Refresh the dashboard.",
  ],
  [
    "the user is no required reviewer",
    { status: "waiting", name: "Release" },
    pending(false),
    "Your GitHub account can't approve this environment. Check its required reviewers on GitHub.",
  ],
])("approving is refused when %s, sending nothing", async (_, now, deployments, message) => {
  const { actions, sent, dashboard } = setUp({
    [`GET ${RUN}`]: { id: 1, conclusion: null, path: FILE, ...now },
    [`GET ${RUN}/pending_deployments`]: deployments,
  });
  await expect(actions.review(waitingRun, production, "approved")).rejects.toThrow(message);
  expect(sent()).toEqual([]);
  expect(dashboard.changed).not.toHaveBeenCalled();
});

test("in a repository that marks its release workflows, only a run of a marked one can be approved", async () => {
  const blob = (text: string) => ({ encoding: "base64", content: btoa(text) });
  const routes = {
    [`GET ${WORKFLOWS}`]: [
      { type: "file", path: FILE, sha: "marked" },
      { type: "file", path: ".github/workflows/deploy-docs.yml", sha: "plain" },
    ],
    [`GET repos/${REPO}/git/blobs/marked`]: blob("name: Ship\n# dashboard: release\non: push\n"),
    [`GET repos/${REPO}/git/blobs/plain`]: blob("name: Deploy docs\non: push\n"),
    [`GET ${RUN}/pending_deployments`]: pending(),
    [`POST ${RUN}/pending_deployments`]: [],
  };
  const docs = setUp({
    ...routes,
    [`GET ${RUN}`]: { id: 1, name: "Deploy docs", path: ".github/workflows/deploy-docs.yml", status: "waiting" },
  });
  await expect(docs.actions.review(waitingRun, production, "approved")).rejects.toThrow(
    "Only unfinished runs of release workflows can be approved from this dashboard.",
  );
  expect(docs.sent()).toEqual([]);
  const ship = setUp({ ...routes, [`GET ${RUN}`]: { id: 1, name: "Ship", path: FILE, status: "waiting" } });
  await ship.actions.review(waitingRun, production, "approved");
  expect(ship.sent()).toHaveLength(1);
});

const failedRun = run({ state: "failed" });

test("re-running the failed jobs checks that the run finished and failed, then asks GitHub", async () => {
  const { actions, sent, dashboard } = setUp({
    [`GET ${RUN}`]: { id: 1, name: "Release", status: "completed", conclusion: "cancelled" },
    [`POST ${RUN}/rerun-failed-jobs`]: {},
  });
  await actions.rerunFailed(failedRun);
  expect(sent()).toEqual([{ method: "POST", path: `${RUN}/rerun-failed-jobs`, body: {} }]);
  expect(dashboard.changed).toHaveBeenCalledWith({ kind: "workflow_run", repo: REPO, run: 1 });
});

test.each([
  [
    { status: "in_progress", conclusion: null },
    "GitHub re-runs failed jobs only once the workflow run has finished. Try again then.",
  ],
  [
    { status: "completed", conclusion: "success" },
    "This workflow run has no failed jobs to re-run. Refresh the dashboard.",
  ],
])("re-running the failed jobs of a run that is %o is refused", async (now, message) => {
  const { actions, sent } = setUp({ [`GET ${RUN}`]: { id: 1, name: "Release", ...now } });
  await expect(actions.rerunFailed(failedRun)).rejects.toThrow(message);
  expect(sent()).toEqual([]);
});

const failedJob: Job = {
  id: 11,
  name: "build",
  state: "failed",
  url: undefined,
  startedAt: undefined,
  finishedAt: undefined,
};
const JOBS = `repos/${REPO}/actions`;

test("re-running a job checks the job and its whole run, then asks GitHub", async () => {
  const { actions, asked, sent, dashboard } = setUp({
    [`GET ${JOBS}/jobs/11`]: { id: 11, run_id: 1, status: "completed", conclusion: "timed_out" },
    [`GET ${RUN}`]: { id: 1, name: "Release", status: "completed", conclusion: "failure" },
    [`POST ${JOBS}/jobs/11/rerun`]: {},
  });
  await actions.rerunJob(failedRun, failedJob);
  expect(asked.map((one) => `${one.method} ${one.path}`)).toEqual([
    `GET ${JOBS}/jobs/11`,
    `GET ${RUN}`,
    `POST ${JOBS}/jobs/11/rerun`,
  ]);
  expect(sent()[0]?.body).toEqual({});
  expect(dashboard.changed).toHaveBeenCalledWith({ kind: "workflow_job", repo: REPO, run: 1 });
});

test.each([
  [
    { status: "completed", conclusion: "success" },
    "completed",
    "Only a failed or cancelled job can be re-run. Refresh the dashboard.",
  ],
  [
    { status: "in_progress", conclusion: null },
    "completed",
    "Only a failed or cancelled job can be re-run. Refresh the dashboard.",
  ],
  [
    { status: "completed", conclusion: "failure" },
    "in_progress",
    "GitHub re-runs a job only once its whole workflow run has finished. Try again then.",
  ],
])("re-running a job that is %o in a run that is %s is refused", async (job, runStatus, message) => {
  const { actions, sent } = setUp({
    [`GET ${JOBS}/jobs/11`]: { id: 11, run_id: 1, ...job },
    [`GET ${RUN}`]: { id: 1, name: "Release", status: runStatus, conclusion: null },
  });
  await expect(actions.rerunJob(failedRun, failedJob)).rejects.toThrow(message);
  expect(sent()).toEqual([]);
});

test.each([
  [[], undefined, "v1.0.0"],
  [["v1.2.3"], "v1.2.3", "v1.3.0"],
  [["1.9.0", "1.10.2", "1.2.0"], "1.10.2", "1.11.0"],
  [["v2.0.0", "v3.0.0-rc.2", "not-a-version"], "v3.0.0-rc.2", "v3.1.0"],
  [["v3.0.0-rc.2", "v3.0.0"], "v3.0.0", "v3.1.0"],
  [["v1.4.0+build.7"], "v1.4.0+build.7", "v1.5.0"],
])("after the releases %j the next is %s → %s", (tags, previous, tag) => {
  expect(nextTag(tags)).toEqual({ previous, tag });
});

test("with releases but none a version, the next one isn't known", () => {
  expect(() => nextTag(["nightly", "latest"])).toThrow("No release has a version tag");
});

const RELEASES = `repos/${REPO}/releases`;
const releaseRoutes = (more: Record<string, unknown> = {}) => ({
  [`GET ${RELEASES}`]: [
    { tag_name: "v1.2.3", draft: false },
    { tag_name: "v1.9.0", draft: true },
    { tag_name: "v1.0.0", draft: false },
  ],
  [`POST ${RELEASES}`]: { id: 1, tag_name: "v1.3.0" },
  ...more,
});

test("the next release is the next minor of the published ones, unless that tag exists", async () => {
  const { actions, asked } = setUp(releaseRoutes());
  // A draft doesn't count.
  expect(await actions.nextRelease(project())).toBe("v1.3.0");
  expect(asked.map((one) => `${one.method} ${one.path}`)).toEqual([
    `GET ${RELEASES}?per_page=100`,
    `GET repos/${REPO}/git/ref/tags/v1.3.0`,
  ]);

  const taken = setUp(releaseRoutes({ [`GET repos/${REPO}/git/ref/tags/v1.3.0`]: { ref: "refs/tags/v1.3.0" } }));
  await expect(taken.actions.nextRelease(project())).rejects.toThrow(
    "Tag v1.3.0 already exists. Resolve it on GitHub before releasing.",
  );
});

test("releasing checks again and publishes in one call, leaving the branch and the notes to GitHub", async () => {
  const { actions, sent, dashboard } = setUp(releaseRoutes());
  await actions.release(project(), "v1.3.0");
  expect(sent()).toEqual([
    {
      method: "POST",
      path: RELEASES,
      // No target: GitHub tags the head of the default branch.
      body: { tag_name: "v1.3.0", generate_release_notes: true, draft: false, prerelease: false },
    },
  ]);
  expect(dashboard.changed).toHaveBeenCalledWith({ kind: "release", repo: REPO });
  expect(dashboard.changed).toHaveBeenCalledWith({ kind: "workflow_run", repo: REPO });
});

test("the first release is published the same way", async () => {
  const { actions, sent } = setUp(releaseRoutes({ [`GET ${RELEASES}`]: [] }));
  await actions.release(project(), "v1.0.0");
  expect(sent()[0]?.body).toEqual({
    tag_name: "v1.0.0",
    generate_release_notes: true,
    draft: false,
    prerelease: false,
  });
});

test("releasing a tag that is no longer the next one is refused", async () => {
  const { actions, sent } = setUp(releaseRoutes());
  await expect(actions.release(project(), "v1.2.0")).rejects.toThrow(
    "The next release is v1.3.0 now, not v1.2.0. Refresh the dashboard.",
  );
  expect(sent()).toEqual([]);
});

test("a release whose publishing failed says it may have gone through", async () => {
  const { actions } = setUp(releaseRoutes({ [`POST ${RELEASES}`]: () => new Response(null, { status: 502 }) }));
  await expect(actions.release(project(), "v1.3.0")).rejects.toThrow(
    "GitHub is having trouble (502). It may have gone through: check GitHub before trying again.",
  );
});

const promotable = project({ promoteWorkflow: 31 });
const promoteRoutes = (more: Record<string, unknown> = {}) => ({
  [`GET repos/${REPO}/actions/workflows/31`]: { id: 31, path: PROMOTE_WORKFLOW, state: "active" },
  [`GET ${RELEASES}/tags/v1.2.3`]: { tag_name: "v1.2.3" },
  // The branch the workflow is started on is asked for at that moment.
  [`GET repos/${REPO}`]: { default_branch: "trunk" },
  [`POST repos/${REPO}/actions/workflows/31/dispatches`]: () => new Response(null, { status: 204 }),
  ...more,
});

test("promoting checks the workflow and the release, then starts the workflow with the tag", async () => {
  const { actions, sent, dashboard } = setUp(promoteRoutes());
  await actions.promote(promotable, "v1.2.3");
  expect(sent()).toEqual([
    {
      method: "POST",
      path: `repos/${REPO}/actions/workflows/31/dispatches`,
      body: { ref: "trunk", inputs: { tag: "v1.2.3" } },
    },
  ]);
  expect(dashboard.changed).toHaveBeenCalledWith({ kind: "workflow_run", repo: REPO });
});

test.each([
  [
    "a tag that isn't a plain release",
    promotable,
    "v1.2.3-rc.1",
    {},
    "Only a release tag like v1.2.3 can be promoted.",
  ],
  [
    "a project without the workflow",
    project(),
    "v1.2.3",
    {},
    `This project has no active ${PROMOTE_WORKFLOW}. Refresh the dashboard.`,
  ],
  [
    "a workflow that was turned off",
    promotable,
    "v1.2.3",
    { [`GET repos/${REPO}/actions/workflows/31`]: { id: 31, path: PROMOTE_WORKFLOW, state: "disabled_manually" } },
    `This project has no active ${PROMOTE_WORKFLOW}. Refresh the dashboard.`,
  ],
  [
    "a tag that is no published release",
    promotable,
    "v1.2.4",
    {},
    "v1.2.4 is not a published release. Refresh the dashboard.",
  ],
])("promoting is refused for %s", async (_, which, tag, more, message) => {
  const { actions, sent } = setUp(promoteRoutes(more));
  await expect(actions.promote(which, tag)).rejects.toThrow(message);
  expect(sent()).toEqual([]);
});

test("GitHub's refusals are said in words for the user", async () => {
  const refused = setUp({
    [`GET ${RUN}`]: { id: 1, name: "Release", status: "completed", conclusion: "failure" },
    [`POST ${RUN}/rerun-failed-jobs`]: () => Response.json({ message: "Must have admin rights" }, { status: 403 }),
  });
  await expect(refused.actions.rerunFailed(failedRun)).rejects.toThrow("GitHub refused: Must have admin rights.");

  // Each write says which permission it takes, should the app not have it.
  const notAllowed = setUp({
    [`GET ${RUN}`]: { id: 1, name: "Release", path: FILE, status: "waiting", conclusion: null },
    [`GET ${RUN}/pending_deployments`]: pending(),
    [`POST ${RUN}/pending_deployments`]: () =>
      Response.json({ message: "Resource not accessible by integration" }, { status: 403 }),
  });
  await expect(notAllowed.actions.review(waitingRun, production, "approved")).rejects.toThrow(
    "The GitHub App isn't allowed to do this. It needs Deployments with write access.",
  );

  const forbiddenRead = setUp({ [`GET ${RUN}`]: () => new Response(null, { status: 403 }) });
  await expect(forbiddenRead.actions.rerunFailed(failedRun)).rejects.toThrow(/^GitHub refused \(403\)\.$/);

  const limited = setUp({
    [`GET ${RUN}`]: () => Response.json({}, { status: 429, headers: { "retry-after": "60" } }),
  });
  await expect(limited.actions.rerunFailed(failedRun)).rejects.toThrow("GitHub's rate limit is used up.");

  const unreachable = setUp({
    [`GET ${RUN}`]: { id: 1, name: "Release", status: "completed", conclusion: "failure" },
    [`POST ${RUN}/rerun-failed-jobs`]: () => {
      throw new TypeError("Failed to fetch");
    },
  });
  await expect(unreachable.actions.rerunFailed(failedRun)).rejects.toThrow(
    "GitHub couldn't be reached. It may have gone through: check GitHub before trying again.",
  );

  // A read that fails before anything was sent can't have done anything.
  const down = setUp({ [`GET ${RUN}`]: () => new Response(null, { status: 503 }) });
  await expect(down.actions.rerunFailed(failedRun)).rejects.toThrow(/^GitHub is having trouble \(503\)\.$/);
});

test("anything else is described as the dashboard describes a failed read", () => {
  expect(describeAction(new Error("odd"))).toBe("GitHub couldn't be reached.");
});
