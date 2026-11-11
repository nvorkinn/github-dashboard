import type { Auth } from "../auth.ts";
import type { Dashboard, Project, RunActions } from "../model.ts";
import { RELEASE_TAG } from "../model.ts";
import { type Api, createApi, GitHubError } from "./api.ts";
import { approval, isReleaseName, PROMOTE_WORKFLOW, type RawPendingDeployment } from "./read.ts";
import { ActionError, send as sendWrite, worded } from "./writes.ts";

// What a finished job or run ends in when GitHub's re-run of its failed jobs runs it again (cancelled ones too).
const RERUNNABLE = new Set(["failure", "timed_out", "cancelled"]);

// What GitHub's history of the approval says about where it came from.
export const APPROVED_COMMENT = "Approved from the GitHub dashboard.";
export const REJECTED_COMMENT = "Rejected from the GitHub dashboard.";

type RawRun = { id: number; name: string | null; status: string | null; conclusion: string | null };
type RawJob = { id: number; run_id: number; status: string; conclusion: string | null };
type RawRelease = { tag_name: string; draft: boolean };
type RawWorkflow = { id: number; path: string; state: string };

/**
 * The actions on release runs and projects, as the signed-in user straight on api.github.com. Each one checks on
 * GitHub first that it still applies, as the page may be a moment behind, then sends its one write, and on success
 * tells `dashboard` what changed so that it reads it again. Nothing is retried: a write may have gone through even
 * when its answer didn't arrive.
 */
export function createRunActions(auth: Auth, dashboard: Pick<Dashboard, "changed">): RunActions {
  const api = createApi(auth);

  /** Sends one write; `needs` is the permission it takes, said if GitHub says the app hasn't got it. */
  function send(path: string, body: unknown, needs: string): Promise<Response> {
    return sendWrite(auth, path, "POST", body, needs);
  }

  /** Runs an action, turning whatever went wrong into an `ActionError` that says it in words for the user. */
  const act = worded<void>;

  return {
    review(run, wanted, verdict) {
      return act(async () => {
        const path = `repos/${run.repo}/actions/runs/${run.id}`;
        const now = await api.get<RawRun>(path);
        if (now.status === "completed") {
          throw new ActionError("This run has finished, so it no longer waits for an approval. Refresh the dashboard.");
        }
        if (!isReleaseName(now.name)) {
          throw new ActionError(
            "Only unfinished release, promote or deploy workflows can be approved from this dashboard.",
          );
        }
        const pending = (await api.list<RawPendingDeployment>(`${path}/pending_deployments`)).map(approval);
        const found = pending.find((one) => one.environmentId === wanted.environmentId);
        if (!found) {
          throw new ActionError("This deployment is no longer waiting for approval. Refresh the dashboard.");
        }
        if (!found.canApprove) {
          throw new ActionError(
            "Your GitHub account can't approve this environment. Check its required reviewers on GitHub.",
          );
        }
        await send(
          `${path}/pending_deployments`,
          {
            environment_ids: [found.environmentId],
            state: verdict,
            comment: verdict === "approved" ? APPROVED_COMMENT : REJECTED_COMMENT,
          },
          "Deployments",
        );
        dashboard.changed({ kind: "deployment_review", repo: run.repo, run: run.id });
      });
    },

    rerunFailed(run) {
      return act(async () => {
        const path = `repos/${run.repo}/actions/runs/${run.id}`;
        const now = await api.get<RawRun>(path);
        if (now.status !== "completed") {
          throw new ActionError("GitHub re-runs failed jobs only once the workflow run has finished. Try again then.");
        }
        if (!RERUNNABLE.has(now.conclusion ?? "")) {
          throw new ActionError("This workflow run has no failed jobs to re-run. Refresh the dashboard.");
        }
        await send(`${path}/rerun-failed-jobs`, {}, "Actions");
        dashboard.changed({ kind: "workflow_run", repo: run.repo, run: run.id });
      });
    },

    rerunJob(run, job) {
      return act(async () => {
        const path = `repos/${run.repo}/actions`;
        const now = await api.get<RawJob>(`${path}/jobs/${job.id}`);
        if (now.status !== "completed" || !RERUNNABLE.has(now.conclusion ?? "")) {
          throw new ActionError("Only a failed or cancelled job can be re-run. Refresh the dashboard.");
        }
        if ((await api.get<RawRun>(`${path}/runs/${now.run_id}`)).status !== "completed") {
          throw new ActionError("GitHub re-runs a job only once its whole workflow run has finished. Try again then.");
        }
        await send(`${path}/jobs/${job.id}/rerun`, {}, "Actions");
        dashboard.changed({ kind: "workflow_job", repo: run.repo, run: now.run_id });
      });
    },

    async nextRelease(project) {
      let tag = "";
      await act(async () => {
        tag = (await planRelease(api, project)).tag;
      });
      return tag;
    },

    release(project, tag) {
      return act(async () => {
        const plan = await planRelease(api, project);
        // Someone released in the meantime: the tag the user agreed to is no longer the next one.
        if (plan.tag !== tag) {
          throw new ActionError(`The next release is ${plan.tag} now, not ${tag}. Refresh the dashboard.`);
        }
        const path = `repos/${project.repo}/releases`;
        const target = { tag_name: tag, target_commitish: project.defaultBranch };
        const notes = (await (
          await send(
            `${path}/generate-notes`,
            { ...target, ...(plan.previous ? { previous_tag_name: plan.previous } : {}) },
            "Contents",
          )
        ).json()) as { name: string; body: string };
        await send(
          path,
          { ...target, name: notes.name, body: notes.body, draft: false, prerelease: false },
          "Contents",
        );
        dashboard.changed({ kind: "release", repo: project.repo });
        // The tag starts the project's release workflow, whose run shows once it is read.
        dashboard.changed({ kind: "workflow_run", repo: project.repo });
      });
    },

    promote(project, tag) {
      return act(async () => {
        if (!RELEASE_TAG.test(tag)) {
          throw new ActionError("Only a release tag like v1.2.3 can be promoted.");
        }
        const path = `repos/${project.repo}`;
        const workflow =
          project.promoteWorkflow === undefined
            ? undefined
            : await gone(api.get<RawWorkflow>(`${path}/actions/workflows/${project.promoteWorkflow}`));
        if (workflow?.state !== "active" || workflow.path !== PROMOTE_WORKFLOW) {
          throw new ActionError(`This project has no active ${PROMOTE_WORKFLOW}. Refresh the dashboard.`);
        }
        if (!(await gone(api.get(`${path}/releases/tags/${encodeURIComponent(tag)}`)))) {
          throw new ActionError(`${tag} is not a published release. Refresh the dashboard.`);
        }
        // The workflow checks the rest itself, such as that dev has the release, before it asks for an approval.
        await send(
          `${path}/actions/workflows/${workflow.id}/dispatches`,
          { ref: project.defaultBranch, inputs: { tag } },
          "Actions",
        );
        dashboard.changed({ kind: "workflow_run", repo: project.repo });
      });
    },
  };
}

/** The tag the project's next release gets, after checking that no tag of that name exists already. */
async function planRelease(api: Api, project: Project): Promise<{ previous: string | undefined; tag: string }> {
  const releases = (await api.list<RawRelease>(`repos/${project.repo}/releases`)).filter((one) => !one.draft);
  const plan = nextTag(releases.map((one) => one.tag_name));
  // A tag left over from somewhere else may point at an older commit, which the release would then be of.
  if (await gone(api.get(`repos/${project.repo}/git/ref/tags/${encodeURIComponent(plan.tag)}`))) {
    throw new ActionError(`Tag ${plan.tag} already exists. Resolve it on GitHub before releasing.`);
  }
  return plan;
}

/** What `reading` read, or undefined if GitHub answered 404. */
async function gone<T>(reading: Promise<T>): Promise<T | undefined> {
  try {
    return await reading;
  } catch (error) {
    if (error instanceof GitHubError && error.status === 404) {
      return undefined;
    }
    throw error;
  }
}

const SEMVER = /^(v?)(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

/**
 * The next minor version after the highest of these release tags, with the `v` of that tag or without it, and the
 * tag it follows. A prerelease counts, below its own release: after `v3.0.0-rc.2` comes `v3.1.0`. Tags that aren't
 * versions are passed over; with no release at all the first is `v1.0.0`.
 */
export function nextTag(tags: string[]): { previous: string | undefined; tag: string } {
  if (tags.length === 0) {
    return { previous: undefined, tag: "v1.0.0" };
  }
  let best: { tag: string; key: number[]; prefix: string } | undefined;
  for (const tag of tags) {
    const match = SEMVER.exec(tag);
    if (!match) {
      continue;
    }
    const key = [Number(match[2]), Number(match[3]), Number(match[4]), match[5] === undefined ? 1 : 0];
    if (!best || compare(key, best.key) > 0) {
      best = { tag, key, prefix: match[1] ?? "" };
    }
  }
  if (!best) {
    throw new ActionError("No release has a version tag such as v1.19.0, so the next one isn't known.");
  }
  const [major, minor] = best.key as [number, number];
  return { previous: best.tag, tag: `${best.prefix}${major}.${minor + 1}.0` };
}

function compare(a: number[], b: number[]): number {
  for (let index = 0; index < a.length; index++) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) {
      return difference;
    }
  }
  return 0;
}
