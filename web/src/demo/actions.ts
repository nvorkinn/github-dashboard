import { nextTag } from "../github/run_actions.ts";
import type { DashboardData, Job, Project, ReleaseRun, RunActions } from "../model.ts";

/** How long a demo action takes, so its button shows that it is under way. */
export const ACTION_MS = 900;

/** The one sample action that fails, so that the preview shows how a failure looks: releasing garden-sensors. */
export const FAILING_PROJECT = "garden-sensors";

/** What the demo's actions did to the sample data. The data is drawn anew from the script each time, then this. */
export type DemoEdits = {
  /** Per run, the approval it was given and when. */
  reviewed: Map<number, { verdict: "approved" | "rejected"; at: number }>;
  /** Per run, when its failed jobs (or only `job`) were re-run. */
  rerun: Map<number, { at: number; job: number | undefined }>;
  /** Per project, the release it got. */
  released: Map<string, { tag: string; at: number }>;
  /** The runs the actions started, newest last. */
  started: ReleaseRun[];
};

export function noEdits(): DemoEdits {
  return { reviewed: new Map(), rerun: new Map(), released: new Map(), started: [] };
}

/** Forgets everything the actions did, such as when the demo stops. */
export function clearEdits(edits: DemoEdits): void {
  edits.reviewed.clear();
  edits.rerun.clear();
  edits.released.clear();
  edits.started.length = 0;
}

/** Forgets what was done to one run, such as the scripted one when its script starts over. */
export function forgetRun(edits: DemoEdits, id: number): void {
  edits.reviewed.delete(id);
  edits.rerun.delete(id);
}

/** `data` with what the actions did: the next thing a real read of GitHub would show. */
export function applyEdits(data: DashboardData, edits: DemoEdits): DashboardData {
  const projects = data.projects.map((project) => {
    const release = edits.released.get(project.repo);
    return release
      ? {
          ...project,
          latestRelease: {
            tag: release.tag,
            url: `${project.url}/releases/tag/${release.tag}`,
            publishedAt: new Date(release.at).toISOString(),
          },
        }
      : project;
  });
  const releases = [...data.releases, ...edits.started].map((run) => rerun(review(run, edits), edits));
  return { ...data, projects, releases };
}

function review(run: ReleaseRun, edits: DemoEdits): ReleaseRun {
  const done = edits.reviewed.get(run.id);
  if (!done || !run.jobs.some((job) => job.state === "waiting")) {
    return run;
  }
  const at = new Date(done.at).toISOString();
  if (done.verdict === "rejected") {
    return {
      ...run,
      state: "failed",
      finishedAt: at,
      approvals: [],
      jobs: run.jobs.map((job) =>
        job.state === "waiting"
          ? { ...job, state: "failed", finishedAt: at }
          : job.state === "queued"
            ? { ...job, state: "skipped" }
            : job,
      ),
    };
  }
  // The approval passes, and the first job that waited on it starts.
  let next = true;
  const jobs = run.jobs.map((job): Job => {
    if (job.state === "waiting") {
      return { ...job, state: "passed" };
    }
    if (job.state === "queued" && next) {
      next = false;
      return { ...job, state: "running", startedAt: at };
    }
    return job;
  });
  return { ...run, state: "running", approvals: [], jobs };
}

function rerun(run: ReleaseRun, edits: DemoEdits): ReleaseRun {
  const done = edits.rerun.get(run.id);
  if (!done || run.finishedAt === undefined) {
    return run;
  }
  const again = (job: Job) =>
    done.job === undefined ? job.state === "failed" || job.state === "cancelled" : job.id === done.job;
  return {
    ...run,
    state: "queued",
    startedAt: new Date(done.at).toISOString(),
    finishedAt: undefined,
    // The jobs re-run, and the ones that were skipped for want of them, are waiting for a runner again.
    jobs: run.jobs.map((job) =>
      again(job) || job.state === "skipped"
        ? { ...job, state: "queued", startedAt: undefined, finishedAt: undefined }
        : job,
    ),
  };
}

/**
 * The demo's actions: each takes a moment and then changes the sample data the way the real one changes GitHub.
 * `later` runs a task after a delay unless the demo stops first; `changed` draws the data again.
 */
export function demoRunActions(
  edits: DemoEdits,
  later: (ms: number, task: () => void) => void,
  changed: () => void,
): RunActions {
  /** Waits the action's moment, then does `task`; fails with its error instead if it throws. */
  function act<T>(task: () => T): Promise<T> {
    return new Promise((resolve, reject) => {
      later(ACTION_MS, () => {
        try {
          resolve(task());
          changed();
        } catch (error) {
          reject(error);
        }
      });
    });
  }

  let nextId = 9500;
  function start(project: Project, workflow: string, title: string, names: string[]): void {
    const now = Date.now();
    const id = nextId++;
    edits.started.push({
      repo: project.repo,
      id,
      workflow,
      title,
      url: `${project.url}/actions/runs/${id}`,
      state: "running",
      actor: "octocat",
      startedAt: new Date(now).toISOString(),
      finishedAt: undefined,
      jobs: names.map((name, index) => ({
        id: id * 100 + index,
        name,
        state: index === 0 ? "running" : "queued",
        url: undefined,
        startedAt: index === 0 ? new Date(now).toISOString() : undefined,
        finishedAt: undefined,
      })),
      approvals: [],
    });
  }

  return {
    review: (run, _approval, verdict) =>
      act(() => {
        edits.reviewed.set(run.id, { verdict, at: Date.now() });
      }),

    rerunFailed: (run) =>
      act(() => {
        edits.rerun.set(run.id, { at: Date.now(), job: undefined });
      }),

    rerunJob: (run, job) =>
      act(() => {
        edits.rerun.set(run.id, { at: Date.now(), job: job.id });
      }),

    nextRelease: (project) =>
      act(() => {
        const { tag } = nextTag(project.latestRelease ? [project.latestRelease.tag] : []);
        if (project.name === FAILING_PROJECT) {
          throw new Error(`Tag ${tag} already exists. Resolve it on GitHub before releasing.`);
        }
        return tag;
      }),

    release: (project, tag) =>
      act(() => {
        edits.released.set(project.repo, { tag, at: Date.now() });
        start(project, "Release", tag, ["version", "build", "publish release"]);
      }),

    promote: (project, tag) =>
      act(() => {
        start(project, "Promote", tag, ["check tag", "approve-prod", "deploy prod"]);
      }),
  };
}
