import type { ReleaseRun, ReleasesSnapshot } from "../../shared/runs.ts";
import type { GitHubApp } from "./github_app.ts";
import { createRuns } from "./runs.ts";
import { createDefinitions } from "./workflows.ts";

/** How often every repository's workflow files are looked at again, in case a push's webhook never came. */
export const DEFINITIONS_MS = 60 * 60_000;
/** How often the runs still going are read again, in case one of their webhooks never came. */
export const RUNS_MS = 3 * 60_000;

/** What the relay knows of release runs without being able to read GitHub: nothing. */
export const NOT_CONFIGURED: ReleasesSnapshot = { configured: false, projects: {}, runs: [] };

/**
 * The release runs of every repository the GitHub App reaches, kept by the relay and told to the open pages: which
 * workflows are releases and what their jobs are (see workflows.ts), and how their runs stand (see runs.ts). Both
 * are read from GitHub when the relay starts and then follow its webhooks. All of it is in memory only.
 */
export type Releases = {
  /** Takes in a signed webhook. */
  onWebhook(kind: string, payload: Record<string, unknown>): void;
  /** Everything known now. */
  snapshot(): ReleasesSnapshot;
  /** Whether the workflow file `path` of `repo` is a release workflow; undefined for a repository not read. */
  isRelease(repo: string, path: string): boolean | undefined;
  /** Resolves once the read made at the start is in. */
  ready: Promise<void>;
};

export function createReleases(options: {
  /** Reads GitHub as the app. */
  app: GitHubApp;
  /** One run changed. */
  onRun(run: ReleaseRun): void;
  /** More than one run changed, or what is known of a repository did: everything is told again. */
  onSnapshot(snapshot: ReleasesSnapshot): void;
  /** Stops the timers when it fires. */
  closing?: AbortSignal | undefined;
}): Releases {
  const { app } = options;
  // What was last told as a whole, so that looking at a repository again and finding it the same tells nothing.
  let told: string | undefined;

  function snapshot(): ReleasesSnapshot {
    return {
      configured: true,
      projects: Object.fromEntries(
        definitions.repos().map((repo) => {
          const promoteWorkflow = definitions.promoteWorkflow(repo);
          return [repo, promoteWorkflow === undefined ? {} : { promoteWorkflow }];
        }),
      ),
      runs: runs.all(),
    };
  }

  function tellAll(): void {
    const now = snapshot();
    const text = JSON.stringify(now);
    if (text !== told) {
      told = text;
      options.onSnapshot(now);
    }
  }

  const definitions = createDefinitions({
    app,
    onChange(repo) {
      void runs.reconcile(repo).then(tellAll);
    },
  });
  const runs = createRuns({
    app,
    definitions,
    onRun(run) {
      // The whole is no longer what was told last.
      told = undefined;
      options.onRun(run);
    },
    onRuns: tellAll,
  });

  const ready = definitions.load();
  if (!options.closing?.aborted) {
    const again = setInterval(() => void definitions.load(), DEFINITIONS_MS);
    const recheck = setInterval(() => void runs.recheck(), RUNS_MS);
    // Neither keeps the relay from stopping.
    again.unref();
    recheck.unref();
    options.closing?.addEventListener("abort", () => {
      clearInterval(again);
      clearInterval(recheck);
    });
  }

  return {
    onWebhook(kind, payload) {
      definitions.onWebhook(kind, payload);
      runs.onWebhook(kind, payload);
    },
    snapshot,
    isRelease: (repo, path) => definitions.isRelease(repo, path),
    ready,
  };
}
