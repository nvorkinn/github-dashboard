import { approval, PROMOTE_WORKFLOW, type RawPendingDeployment } from "../../../shared/runs.ts";
import { nextVersion } from "../../../shared/versions.ts";
import type { Auth } from "../auth.ts";
import type { Dashboard, Project, RunActions } from "../model.ts";
import { RELEASE_TAG } from "../model.ts";
import { type Api, createApi, GitHubError } from "./api.ts";
import { ActionError, send as sendWrite, worded } from "./writes.ts";

// What a finished job or run ends in when GitHub's re-run of its failed jobs runs it again (cancelled ones too).
const RERUNNABLE = new Set(["failure", "timed_out", "cancelled"]);

// What GitHub's history of the approval says about where it came from.
export const APPROVED_COMMENT = "Approved from the GitHub dashboard.";
export const REJECTED_COMMENT = "Rejected from the GitHub dashboard.";

type RawRun = { id: number; status: string | null; conclusion: string | null };
type RawJob = { id: number; run_id: number; status: string; conclusion: string | null };
type RawRelease = { tag_name: string; draft: boolean };
type RawWorkflow = { id: number; path: string; state: string };

/**
 * The actions on release runs and projects, as the signed-in user straight on api.github.com. Each one checks on
 * GitHub first that it still applies, as the page may be a moment behind, then sends its one write. How a run stands
 * afterwards the relay tells the page, as for every run; what the page reads itself (a new release, whether an
 * approval is still the user's to give) `dashboard` is told to read again. Nothing is retried: a write may have gone
 * through even when its answer didn't arrive.
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
        // Without a target, GitHub makes the tag at the head of the default branch; it writes the notes itself.
        await send(
          `repos/${project.repo}/releases`,
          { tag_name: tag, generate_release_notes: true, draft: false, prerelease: false },
          "Contents",
        );
        // The tag starts the project's release workflow, whose run shows once the relay hears of it.
        dashboard.changed({ kind: "release", repo: project.repo });
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
        // A workflow is started on a branch, which has to be named: the default one, asked for only now.
        const { default_branch: ref } = await api.get<{ default_branch: string }>(path);
        // The workflow checks the rest itself, such as that dev has the release, before it asks for an approval.
        await send(`${path}/actions/workflows/${workflow.id}/dispatches`, { ref, inputs: { tag } }, "Actions");
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

/**
 * The next minor version after the highest of these release tags (see `nextVersion`), or an error for the user when
 * none of them is a version.
 */
export function nextTag(tags: string[]): { previous: string | undefined; tag: string } {
  const next = nextVersion(tags);
  if (!next) {
    throw new ActionError("No release has a version tag such as v1.19.0, so the next one isn't known.");
  }
  return next;
}
