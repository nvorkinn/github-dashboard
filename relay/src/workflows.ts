import { PROMOTE_WORKFLOW } from "../../shared/runs.ts";
import {
  readWorkflowBlob,
  releasePaths,
  WORKFLOWS_FOLDER,
  type WorkflowBlob,
  type WorkflowJob,
} from "../../shared/workflows.ts";
import { AppError, type GitHubApp, reasonOf } from "./github_app.ts";
import { isRecord, record, text, wholeNumber } from "./payload.ts";

/** A workflow as the relay knows it from its file on the default branch. */
export type Definition = {
  /** The workflow's name: the file's `name`, or what GitHub calls it, or its path. */
  name: string;
  /** Its jobs and which waits for which; undefined when the file isn't a workflow this can read. */
  jobs: WorkflowJob[] | undefined;
};

/** A release workflow GitHub can start: one that isn't disabled. */
export type ReleaseWorkflow = { id: number; path: string };

/**
 * Every repository's workflow files as they are on its default branch, read as the GitHub App and kept in memory:
 * which of them are release workflows (see `releasePaths`), their jobs, and the repository's Promote workflow.
 *
 * They are read when the relay starts, again for a repository when something is pushed to its default branch, and
 * all of them every so often in case a webhook never came. A file is fetched only when its content changed. Nothing
 * is written anywhere: a restart reads them again.
 */
export type Definitions = {
  /**
   * Reads every repository the app reaches, and forgets the ones it no longer does. A repository that can't be read
   * stays as it was.
   */
  load(): Promise<void>;
  /** Takes in a webhook: a push to a default branch, or a change to which repositories there are. */
  onWebhook(kind: string, payload: Record<string, unknown>): void;
  /** Resolves once whatever is being read of `repo` right now is in. */
  settled(repo: string): Promise<void>;
  /** The repositories read so far. */
  repos(): string[];
  /** The installation of the app that reaches `repo`. */
  installationOf(repo: string): number | undefined;
  /** Whether the workflow file `path` of `repo` is a release workflow; undefined for a repository not read. */
  isRelease(repo: string, path: string): boolean | undefined;
  /** The workflow in the file `path` of `repo`, as it is now. */
  definition(repo: string, path: string): Definition | undefined;
  /** The release workflows of `repo` that aren't disabled. */
  releaseWorkflows(repo: string): ReleaseWorkflow[];
  /** The id of the repository's active Promote workflow, if it has one. */
  promoteWorkflow(repo: string): number | undefined;
};

type Repo = {
  installation: number;
  defaultBranch: string | undefined;
  /** The YAML files directly in the workflows folder, by path. */
  files: Map<string, { sha: string; blob: WorkflowBlob }>;
  /** The paths of the release workflows among them. */
  releases: Set<string>;
  /** What GitHub lists as the repository's workflows that have a file. */
  workflows: { id: number; path: string; name: string; active: boolean }[];
};

export function createDefinitions(options: {
  app: GitHubApp;
  /** Told after a repository was read, or forgotten: what the relay knows of it may have changed. */
  onChange?: (repo: string) => void;
}): Definitions {
  const { app } = options;
  const repos = new Map<string, Repo>();
  // Per repository: the reading of it under way, each read waiting for the one before.
  const chains = new Map<string, Promise<void>>();
  let loading: Promise<void> | undefined;

  /** Runs `work` for `repo` after whatever is under way for it. It never rejects. */
  function queue(repo: string, work: () => Promise<void>): Promise<void> {
    const next = (chains.get(repo) ?? Promise.resolve()).then(work).catch((error: unknown) => {
      console.warn(`workflows of ${repo} not read: ${reasonOf(error)}`);
    });
    chains.set(repo, next);
    void next.then(() => {
      if (chains.get(repo) === next) {
        chains.delete(repo);
      }
    });
    return next;
  }

  async function read(repo: string, installation: number, defaultBranch: string | undefined): Promise<void> {
    const before = repos.get(repo);
    const [listing, workflows] = await Promise.all([
      // Without the folder there are no workflow files.
      app.get<unknown>(installation, `repos/${repo}/contents/${WORKFLOWS_FOLDER}`).catch((error: unknown) => {
        if (error instanceof AppError && error.status === 404) {
          return [];
        }
        throw error;
      }),
      app.list<unknown>(installation, `repos/${repo}/actions/workflows`, "workflows"),
    ]);
    const files: Repo["files"] = new Map();
    await Promise.all(
      (Array.isArray(listing) ? listing : []).map(async (entry: unknown) => {
        const path = isRecord(entry) ? text(entry.path) : undefined;
        const sha = isRecord(entry) ? text(entry.sha) : undefined;
        if (!isRecord(entry) || entry.type !== "file" || !path || !sha || !/\.ya?ml$/.test(path)) {
          return;
        }
        // The same content as before says the same.
        const kept = before?.files.get(path);
        if (kept?.sha === sha) {
          files.set(path, kept);
          return;
        }
        const raw = await app.get<unknown>(installation, `repos/${repo}/git/blobs/${sha}`);
        const content =
          isRecord(raw) && raw.encoding === "base64" && typeof raw.content === "string" ? raw.content : "";
        files.set(path, { sha, blob: readWorkflowBlob(Buffer.from(content, "base64").toString("utf8")) });
      }),
    );
    repos.set(repo, {
      installation,
      defaultBranch: defaultBranch ?? before?.defaultBranch,
      files,
      releases: new Set(releasePaths([...files].map(([path, file]) => ({ path, blob: file.blob })))),
      workflows: workflows.flatMap((raw) => {
        const id = isRecord(raw) ? wholeNumber(raw.id) : undefined;
        const path = isRecord(raw) ? text(raw.path) : undefined;
        if (!isRecord(raw) || id === undefined || !path?.startsWith(`${WORKFLOWS_FOLDER}/`)) {
          return [];
        }
        return [{ id, path, name: text(raw.name) ?? path, active: raw.state === "active" }];
      }),
    });
    options.onChange?.(repo);
  }

  function load(): Promise<void> {
    // Callers that arrive during a load share it.
    loading ??= (async () => {
      const found = await app.repositories();
      const names = new Set(found.map((one) => one.repo));
      for (const repo of [...repos.keys()]) {
        if (!names.has(repo)) {
          repos.delete(repo);
          options.onChange?.(repo);
        }
      }
      await Promise.all(found.map((one) => queue(one.repo, () => read(one.repo, one.installation, one.defaultBranch))));
    })()
      .catch((error: unknown) => {
        console.warn(`repositories not read: ${reasonOf(error)}`);
      })
      .finally(() => {
        loading = undefined;
      });
    return loading;
  }

  return {
    load,

    onWebhook(kind, payload) {
      if (kind === "repository" || kind === "installation" || kind === "installation_repositories") {
        // Rare, and any of them can add, remove or rename repositories: everything is looked at again.
        void (loading ?? Promise.resolve()).then(load);
        return;
      }
      if (kind !== "push") {
        return;
      }
      const repository = record(payload.repository);
      const repo = text(repository.full_name);
      const branch = text(repository.default_branch);
      if (repo === undefined || branch === undefined || payload.ref !== `refs/heads/${branch}`) {
        return;
      }
      const installation = wholeNumber(record(payload.installation).id) ?? repos.get(repo)?.installation;
      if (installation !== undefined) {
        void queue(repo, () => read(repo, installation, branch));
      }
    },

    async settled(repo) {
      // More may have been asked for while waiting.
      for (let waiting = chains.get(repo); waiting; waiting = chains.get(repo)) {
        await waiting;
      }
    },
    repos: () => [...repos.keys()],
    installationOf: (repo) => repos.get(repo)?.installation,

    isRelease(repo, path) {
      return repos.get(repo)?.releases.has(path);
    },

    definition(repo, path) {
      const known = repos.get(repo);
      const file = known?.files.get(path);
      if (!known || !file) {
        return undefined;
      }
      const name = file.blob.name ?? known.workflows.find((one) => one.path === path)?.name ?? path;
      return { name, jobs: file.blob.jobs };
    },

    releaseWorkflows(repo) {
      const known = repos.get(repo);
      return (known?.workflows ?? [])
        .filter((one) => one.active && known?.releases.has(one.path))
        .map(({ id, path }) => ({ id, path }));
    },

    promoteWorkflow(repo) {
      return repos.get(repo)?.workflows.find((one) => one.active && one.path === PROMOTE_WORKFLOW)?.id;
    },
  };
}
