/**
 * Reads everything the dashboard shows through GitHub's GraphQL API, in a handful of requests sent side by side where
 * the REST API takes a dozen per project. What comes back is put into the shapes of the REST answers and then into the model by the same code
 * as a read of changes (read.ts), so the two can't differ in what they make of GitHub's words.
 *
 * A read asks for:
 *
 * - every repository the signed-in user reaches through the app: what a project's row shows, nothing more;
 * - of each project that isn't hidden: its open pull requests with their checks, and its workflow files;
 * - of each release workflow: whether its latest runs finished, and the latest as its card shows it; of a run that
 *   is going, asked for after, its jobs, pending approvals and workflow file.
 *
 * GraphQL has no list of a repository's workflows, so a workflow is asked for by its file's address on github.com,
 * and which files to ask for has to be known before asking: that is the `Shape`, which a read gives back for the
 * next one. A read that finds it wrong (no shape yet, a new project, a new release workflow, a workflow file not
 * seen before) asks again for what is missing, so only such a read takes more than one round of requests.
 */
import type { Auth } from "../auth.ts";
import type { Approval, DashboardData, Job, PullRequest, ReleaseRun } from "../model.ts";
import { createApi, GitHubError, limiter, MAX_PARALLEL, retryAt } from "./api.ts";
import {
  approval,
  isReleaseName,
  isWaiting,
  job,
  latestOf,
  of,
  PROMOTE_WORKFLOW,
  problemOf,
  project,
  pullOf,
  pullRequest,
  pullRequests,
  type RawCheckRun,
  type RawPull,
  type RawRepo,
  type RawRun,
  type RawStatus,
  RECENT_RELEASES,
  type ReadResult,
  type ReleasePaths,
  refused,
  runJobs,
  runOf,
  settingsOf,
  shownRuns,
} from "./read.ts";
import {
  hasWorkflowBlobs,
  keepWorkflowBlob,
  keptWorkflowBlob,
  readWorkflowBlob,
  WORKFLOWS_FOLDER,
  type WorkflowBlob,
} from "./workflow_graph.ts";

// How much one request asks for. GitHub refuses a query that could name more than 500,000 things, and charges the
// rate limit by how many lists it reads, so these are no larger than they need to be. What doesn't fit is read
// the way a read of changes reads it.
export const REPOS_PER_PAGE = 100;
export const PULLS_PER_REPO = 50;
export const CHECKS_PER_PULL = 100;
export const JOBS_PER_RUN = 100;
const APPROVALS_PER_RUN = 20;
// How many projects and workflows one request asks about. GitHub answers a query's fields one after another, each
// project and workflow taking about a tenth of a second, so a read sends its requests side by side: a few in each
// is several times faster than all in one.
export const REPOS_PER_REQUEST = 7;
export const WORKFLOWS_PER_REQUEST = 7;
const EXTRAS_PER_REQUEST = 50;
// A read never needs this many rounds of requests; one that would has gone wrong, and stops.
const MAX_ROUNDS = 10;
const DEFAULT_BACKOFF_MS = 60_000;

/**
 * Per project (`owner/name`), the paths of the workflow files whose workflows a read asks about: its release
 * workflows and its Promote workflow. Only names, so it can be kept in the browser between visits.
 */
export type Shape = Record<string, string[]>;

export type EverythingOptions = {
  /** What was read last, for the parts that can't be read this time. */
  previous?: DashboardData | undefined;
  /** The projects (`owner/name`) to read nothing of but their row. */
  hidden?: ReadonlySet<string> | undefined;
  /** What the last read gave as its `shape`. */
  shape?: Shape | undefined;
  signal?: AbortSignal | undefined;
  /** For what is read through the REST API: how many requests may be under way at once. */
  parallel?: number | undefined;
};

export type EverythingResult = ReadResult & {
  shape: Shape;
  /** Per project whose workflows could be read, its release workflows' files: for a read of changes to tell them by. */
  releasePaths: ReleasePaths;
};

// The parts of GitHub's GraphQL answers that are used.
type GqlRepo = {
  nameWithOwner: string;
  name: string;
  url: string;
  isPrivate: boolean;
  pushedAt: string | null;
  mergeCommitAllowed: boolean;
  squashMergeAllowed: boolean;
  rebaseMergeAllowed: boolean;
  autoMergeAllowed: boolean;
  latestRelease: { tagName: string; url: string; publishedAt: string | null; createdAt: string } | null;
};
type GqlBlob = { text?: string | null } | null;
type GqlEntry = { path: string; type: string; oid: string; object?: GqlBlob };
type GqlContext =
  | {
      __typename: "CheckRun";
      databaseId: number | null;
      name: string;
      status: string;
      conclusion: string | null;
      permalink: string | null;
    }
  | { __typename: "StatusContext"; context: string; state: string; targetUrl: string | null };
type GqlActor = { __typename: string; login: string; avatarUrl?: string } | null;
type GqlPull = {
  id: string;
  number: number;
  title: string;
  url: string;
  isDraft: boolean;
  headRefName: string;
  baseRefName: string;
  headRefOid: string;
  createdAt: string;
  updatedAt: string;
  mergeable: string;
  mergeStateStatus: string;
  autoMergeRequest: object | null;
  author: GqlActor;
  statusCheckRollup: { contexts: { pageInfo: { hasNextPage: boolean }; nodes: (GqlContext | null)[] } } | null;
};
type GqlDetails = {
  workflows: { entries?: GqlEntry[] } | null;
  pullRequests: { pageInfo: { hasNextPage: boolean }; nodes: (GqlPull | null)[] };
};
type GqlJob = {
  databaseId: number;
  name: string;
  status: string;
  conclusion: string | null;
  permalink: string | null;
  startedAt: string | null;
  completedAt: string | null;
};
type GqlRun = {
  id: string;
  databaseId: number;
  displayTitle: string | null;
  event: string;
  url: string;
  createdAt: string;
  updatedAt: string;
  /** Only of a run asked for with its details. */
  pendingDeploymentRequests?: {
    nodes: ({ currentUserCanApprove: boolean; environment: { databaseId: number; name: string } } | null)[];
  } | null;
  checkSuite: {
    status: string;
    conclusion: string | null;
    branch: { name: string } | null;
    creator: GqlActor;
    /** These two only of a run asked for with its details. */
    commit?: { oid: string; file: { oid: string; object?: GqlBlob } | null } | null;
    checkRuns?: { pageInfo: { hasNextPage: boolean }; nodes: (GqlJob | null)[] } | null;
  } | null;
};
type GqlWorkflow = {
  databaseId: number;
  name: string;
  state: string;
  /** Its latest runs, only as far as it takes to tell which of them the page shows. */
  recent: { nodes: ({ id: string; databaseId: number; checkSuite: { status: string } | null } | null)[] };
  /** The latest of them as its card shows it, without its jobs. */
  runs: { nodes: (GqlRun | null)[] };
};
type GqlError = { type?: string; path?: (string | number)[]; message?: string };

const LISTED = `fragment Listed on Repository {
  nameWithOwner name url isPrivate pushedAt
  mergeCommitAllowed squashMergeAllowed rebaseMergeAllowed autoMergeAllowed
  latestRelease { tagName url publishedAt createdAt }
}`;

const PULLS = `fragment Pulls on Repository {
  pullRequests(first: ${PULLS_PER_REPO}, states: OPEN, orderBy: {field: CREATED_AT, direction: DESC}) {
    pageInfo { hasNextPage }
    nodes {
      id number title url isDraft headRefName baseRefName headRefOid createdAt updatedAt
      mergeable mergeStateStatus
      autoMergeRequest { enabledAt }
      author { __typename login avatarUrl }
      statusCheckRollup { contexts(first: ${CHECKS_PER_PULL}) {
        pageInfo { hasNextPage }
        nodes {
          __typename
          ... on CheckRun { databaseId name status conclusion permalink }
          ... on StatusContext { context state targetUrl }
        }
      } }
    }
  }
}`;

// A run as its card shows it.
const RUN = `fragment Run on WorkflowRun {
  id databaseId displayTitle event url createdAt updatedAt
  checkSuite {
    status conclusion
    branch { name }
    creator { __typename login }
  }
}`;

// What only a run that is going shows: its jobs, and the environments it waits for.
const GOING = `fragment Going on WorkflowRun {
  pendingDeploymentRequests(first: ${APPROVALS_PER_RUN}) {
    nodes { currentUserCanApprove environment { databaseId name } }
  }
  checkSuite {
    checkRuns(first: ${JOBS_PER_RUN}) {
      pageInfo { hasNextPage }
      nodes { databaseId name status conclusion permalink startedAt completedAt }
    }
  }
}`;

type Flow = { repo: string; path: string };
type BlobAsk = { repo: string; oid: string };
/** A run by its node id, with the path of its workflow's file. `going`: with its jobs, approvals and workflow file. */
type RunAsk = { repo: string; path: string; id: string; going: boolean };

/** What one request asks for. `texts`: with the workflow files' text, not only which files they are. */
export type Asked = {
  list: { after: string | undefined } | undefined;
  repos: string[];
  flows: Flow[];
  runs: RunAsk[];
  blobs: BlobAsk[];
  texts: boolean;
};

/** A string as GraphQL writes one, which is as JSON does. */
function quoted(text: string): string {
  return JSON.stringify(text);
}

function repository(repo: string): string {
  const [owner = "", name = ""] = repo.split("/");
  return `repository(owner: ${quoted(owner)}, name: ${quoted(name)})`;
}

/** Where github.com has the workflow of the file `path`, which is how GraphQL finds one. */
export function workflowUrl(repo: string, path: string): string {
  return `https://github.com/${repo}/actions/workflows/${encodeURIComponent(path.slice(WORKFLOWS_FOLDER.length + 1))}`;
}

/**
 * The query for `asked`. Each project is the field `r<n>`, each workflow `w<n>`, each run `n<n>` and each workflow
 * file `b<n>`, numbered as they are in `asked`.
 */
export function queryFor(asked: Asked): string {
  const blob = asked.texts ? " object { ... on Blob { text } }" : "";
  const fields: string[] = [];
  if (asked.list) {
    const after = asked.list.after === undefined ? "" : `, after: ${quoted(asked.list.after)}`;
    // Without the affiliations, GitHub leaves out the repositories of the user's organizations.
    fields.push(`viewer { repositories(first: ${REPOS_PER_PAGE}${after}, isArchived: false, affiliations: [OWNER, COLLABORATOR, ORGANIZATION_MEMBER], ownerAffiliations: [OWNER, COLLABORATOR, ORGANIZATION_MEMBER], orderBy: {field: PUSHED_AT, direction: DESC}) {
    pageInfo { hasNextPage endCursor }
    nodes { ...Listed }
  } }`);
  }
  asked.repos.forEach((repo, index) => {
    fields.push(`r${index}: ${repository(repo)} {
    workflows: object(expression: ${quoted(`HEAD:${WORKFLOWS_FOLDER}`)}) { ... on Tree { entries { path type oid${blob} } } }
    ...Pulls
  }`);
  });
  asked.flows.forEach(({ repo, path }, index) => {
    // Of its latest runs the page shows the ones still going and, for a few minutes, the last one that finished.
    // Most of the time that is nothing at all, so the workflow is asked only whether its latest runs finished,
    // and for the latest as its card shows it. A run that is going is asked for by itself after (`n<n>`), with its
    // jobs; so is one that just finished behind a run that is going.
    fields.push(`w${index}: resource(url: ${quoted(workflowUrl(repo, path))}) { ... on Workflow {
    databaseId name state
    recent: runs(first: ${RECENT_RELEASES}, orderBy: {field: CREATED_AT, direction: DESC}) { nodes { id databaseId checkSuite { status } } }
    runs(first: 1, orderBy: {field: CREATED_AT, direction: DESC}) { nodes { ...Run } }
  } }`);
  });
  asked.runs.forEach(({ path, id, going }, index) => {
    // The workflow file as it was at the run's commit says which job waits for which; only which file it is, as its
    // text is nearly always known already. The text of one that isn't is asked for by itself (`b<n>`).
    const more = going ? ` ...Going checkSuite { commit { oid file(path: ${quoted(path)}) { oid } } }` : "";
    fields.push(`n${index}: node(id: ${quoted(id)}) { ... on WorkflowRun { ...Run${more} } }`);
  });
  asked.blobs.forEach(({ repo, oid }, index) => {
    fields.push(`b${index}: ${repository(repo)} { object(oid: ${quoted(oid)}) { ... on Blob { text } } }`);
  });
  const fragments = [
    ...(asked.list ? [LISTED] : []),
    ...(asked.repos.length > 0 ? [PULLS] : []),
    ...(asked.flows.length + asked.runs.length > 0 ? [RUN] : []),
    ...(asked.runs.some((run) => run.going) ? [GOING] : []),
  ];
  return [`query {\n  ${fields.join("\n  ")}\n}`, ...fragments].join("\n");
}

/** `asked` as the requests to send side by side: the list, then a few projects or workflows in each. */
export function split(asked: Asked): Asked[] {
  const nothing: Asked = { list: undefined, repos: [], flows: [], runs: [], blobs: [], texts: asked.texts };
  const chunks = <T>(all: T[], size: number): T[][] =>
    Array.from({ length: Math.ceil(all.length / size) }, (_, index) => all.slice(index * size, (index + 1) * size));
  const extras = Math.max(asked.runs.length, asked.blobs.length);
  return [
    ...(asked.list ? [{ ...nothing, list: asked.list }] : []),
    ...chunks(asked.repos, REPOS_PER_REQUEST).map((repos) => ({ ...nothing, repos })),
    ...chunks(asked.flows, WORKFLOWS_PER_REQUEST).map((flows) => ({ ...nothing, flows })),
    ...Array.from({ length: Math.ceil(extras / EXTRAS_PER_REQUEST) }, (_, index) => ({
      ...nothing,
      runs: asked.runs.slice(index * EXTRAS_PER_REQUEST, (index + 1) * EXTRAS_PER_REQUEST),
      blobs: asked.blobs.slice(index * EXTRAS_PER_REQUEST, (index + 1) * EXTRAS_PER_REQUEST),
    })),
  ];
}

/**
 * Sends one query. Throws what fails every call (a rate limit, a sign-in GitHub no longer accepts, GitHub in
 * trouble, a failing network); what GitHub wouldn't say of one field comes back in `errors`, beside the rest.
 */
async function send(
  auth: Auth,
  query: string,
  signal: AbortSignal | undefined,
): Promise<{ data: Record<string, unknown>; errors: GqlError[] }> {
  signal?.throwIfAborted();
  const response = await auth.github("graphql", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) {
    throw new GitHubError("graphql", response.status, await retryAt(response));
  }
  const body = (await response.json().catch(() => undefined)) as { data?: unknown; errors?: unknown } | undefined;
  const errors = Array.isArray(body?.errors) ? (body.errors as GqlError[]) : [];
  // GraphQL's own rate limit is an answer like any other, with the error inside.
  if (errors.some((error) => error?.type === "RATE_LIMITED")) {
    const reset = response.headers.get("x-ratelimit-reset") ?? "";
    const at = /^\d+$/.test(reset) ? Number(reset) * 1000 : 0;
    throw new GitHubError("graphql", 403, Math.max(at, Date.now() + (at ? 1000 : DEFAULT_BACKOFF_MS)));
  }
  const data = body?.data;
  if (typeof data !== "object" || data === null) {
    throw new GitHubError("graphql", 502, undefined);
  }
  return { data: data as Record<string, unknown>, errors };
}

/**
 * Reads everything the dashboard shows. A project whose pull requests or releases can't be read doesn't take the
 * others down: that part stays as it was in `previous` (or empty on a first read) and `problem` says so. A rate
 * limit, a sign-in GitHub no longer accepts or a failing network is thrown instead, as every other call would fail
 * the same way.
 *
 * Of a hidden project only its row is read: it has no pull requests, releases or Promote workflow here.
 */
export async function readEverything(auth: Auth, options: EverythingOptions = {}): Promise<EverythingResult> {
  const { previous, signal } = options;
  const hidden = options.hidden ?? new Set<string>();
  const shape = options.shape ?? {};
  // On a page that has just loaded no workflow file is known, and asking for all their text at once saves asking
  // again. After that only the files' ids are asked for, and the text of the few that are new.
  const texts = !hasWorkflowBlobs();

  const listed = new Map<string, GqlRepo>();
  let list: Asked["list"] = { after: undefined };
  const details = new Map<string, GqlDetails | undefined>();
  const workflows = new Map<string, GqlWorkflow | "none" | "failed">();
  // The runs asked for by themselves, by node id.
  const extraRuns = new Map<string, GqlRun | undefined>();
  // What a file says, for the files that couldn't be read or kept: only for this read.
  const unkept = new Map<string, WorkflowBlob>();
  // The projects GitHub wouldn't say everything of.
  const troubled = new Set<string>();

  const repoQueue = queue<string>((repo) => repo);
  const flowQueue = queue<Flow>(flowKey);
  const runQueue = queue<RunAsk>((run) => run.id);
  const blobQueue = queue<BlobAsk>(blobKey);
  for (const [repo, paths] of Object.entries(shape)) {
    if (!hidden.has(repo)) {
      repoQueue.add(repo);
      for (const path of paths) {
        flowQueue.add({ repo, path });
      }
    }
  }

  const blobOf = (repo: string, oid: string) => keptWorkflowBlob(repo, oid) ?? unkept.get(blobKey({ repo, oid }));
  /** Takes in a file that came with its text; whether it is known now. */
  function known(repo: string, oid: string, object: GqlBlob | undefined): boolean {
    if (typeof object?.text === "string" && !keptWorkflowBlob(repo, oid)) {
      keepWorkflowBlob(repo, oid, object.text);
    }
    return blobOf(repo, oid) !== undefined;
  }

  /** The paths of the workflows to ask about, once every workflow file of the project is known. */
  function wanted(repo: string): string[] | undefined {
    const files = workflowFiles(details.get(repo));
    const read = files.map((file) => ({ path: file.path, blob: blobOf(repo, file.oid) }));
    if (!read.every((file) => file.blob !== undefined)) {
      return undefined;
    }
    const marked = read.filter((file) => file.blob?.marked);
    const releases = marked.length > 0 ? marked : read.filter((file) => isReleaseName(file.blob?.name ?? file.path));
    const paths = releases.map((file) => file.path);
    if (read.some((file) => file.path === PROMOTE_WORKFLOW) && !paths.includes(PROMOTE_WORKFLOW)) {
      paths.push(PROMOTE_WORKFLOW);
    }
    return paths;
  }

  const limit = limiter(options.parallel ?? MAX_PARALLEL);
  type Answer = Awaited<ReturnType<typeof send>>;

  /** Takes in the answer to one request. */
  function absorb(asked: Asked, { data, errors }: Answer): void {
    // What GitHub wouldn't say, by the field it is under. A run's approvals are the user's to see or not, and a run
    // without them shows without its buttons.
    const refusedFields = new Set<string>();
    for (const error of errors) {
      const field = error?.path?.[0];
      if (typeof field !== "string" || field === "viewer") {
        throw new GitHubError("graphql", 502, undefined);
      }
      if (!error.path?.includes("pendingDeploymentRequests")) {
        refusedFields.add(field);
      }
    }

    if (asked.list) {
      const page = (data.viewer as { repositories?: Page<GqlRepo> } | null | undefined)?.repositories;
      if (!page || !Array.isArray(page.nodes)) {
        throw new GitHubError("graphql", 502, undefined);
      }
      for (const repo of page.nodes) {
        if (repo) {
          listed.set(repo.nameWithOwner, repo);
        }
      }
      list = page.pageInfo?.hasNextPage && page.pageInfo.endCursor ? { after: page.pageInfo.endCursor } : undefined;
    }
    asked.repos.forEach((repo, index) => {
      const answer = data[`r${index}`] as GqlDetails | null | undefined;
      details.set(repo, answer ?? undefined);
      if (!answer || refusedFields.has(`r${index}`)) {
        troubled.add(repo);
      }
      for (const file of workflowFiles(answer ?? undefined)) {
        known(repo, file.oid, file.object);
      }
    });
    asked.flows.forEach((flow, index) => {
      const answer = data[`w${index}`] as Partial<GqlWorkflow> | null | undefined;
      const isRefused = refusedFields.has(`w${index}`);
      // A file GitHub knows no workflow for, such as one that was never on the default branch, has no answer.
      const found = answer && Array.isArray(answer.runs?.nodes) ? (answer as GqlWorkflow) : undefined;
      workflows.set(flowKey(flow), found ?? (isRefused ? "failed" : "none"));
      if (isRefused) {
        troubled.add(flow.repo);
      }
    });
    asked.runs.forEach((run, index) => {
      const answer = data[`n${index}`] as Partial<GqlRun> | null | undefined;
      const found = answer?.id === run.id && !refusedFields.has(`n${index}`) ? (answer as GqlRun) : undefined;
      extraRuns.set(run.id, found);
      const file = found?.checkSuite?.commit?.file;
      if (file) {
        known(run.repo, file.oid, file.object);
      }
    });
    asked.blobs.forEach((blob, index) => {
      const answer = data[`b${index}`] as { object?: GqlBlob } | null | undefined;
      if (!known(blob.repo, blob.oid, answer?.object)) {
        // Not a text, or not to be had: nothing is read out of it, and the next read asks again.
        unkept.set(blobKey(blob), readWorkflowBlob(""));
      }
    });
  }

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const requests = split({
      list,
      repos: repoQueue.take(),
      flows: flowQueue.take(),
      runs: runQueue.take(),
      blobs: blobQueue.take(),
      texts,
    });
    if (requests.length === 0) {
      break;
    }
    const answers = await Promise.all(requests.map((asked) => limit(() => send(auth, queryFor(asked), signal))));
    requests.forEach((asked, index) => {
      absorb(asked, answers[index] as Answer);
    });

    // What this answer shows to be missing still.
    if (!list) {
      for (const repo of listed.keys()) {
        if (!hidden.has(repo)) {
          repoQueue.add(repo);
        }
      }
    }
    for (const [repo, answer] of details) {
      for (const file of workflowFiles(answer)) {
        if (!blobOf(repo, file.oid)) {
          blobQueue.add({ repo, oid: file.oid });
        }
      }
      for (const path of wanted(repo) ?? []) {
        flowQueue.add({ repo, path });
      }
    }
    for (const [key, workflow] of workflows) {
      const [repo = "", path = ""] = key.split("\n");
      const { runs, missing } = shown(workflow, extraRuns);
      for (const { id, going } of missing) {
        if (!extraRuns.has(id)) {
          runQueue.add({ repo, path, id, going });
        }
      }
      for (const run of runs) {
        const file = run.checkSuite?.commit?.file;
        if (file && !blobOf(repo, file.oid)) {
          blobQueue.add({ repo, oid: file.oid });
        }
      }
    }
  }

  // Everything is in; now into the model, project by project.
  const api = createApi(auth, {
    ...(signal ? { signal } : {}),
    ...(options.parallel ? { parallel: options.parallel } : {}),
  });
  const failed = new Set<string>();
  const nextShape: Shape = {};
  const releasePaths: ReleasePaths = {};
  const repos = [...listed.values()].sort((a, b) => (b.pushedAt ?? "").localeCompare(a.pushedAt ?? ""));
  const read = await Promise.all(
    repos.map(async (listedRepo) => {
      const repo = listedRepo.nameWithOwner;
      const raw = rawRepo(listedRepo);
      const latestRelease = latestOf(
        listedRepo.latestRelease
          ? {
              tag_name: listedRepo.latestRelease.tagName,
              html_url: listedRepo.latestRelease.url,
              published_at: listedRepo.latestRelease.publishedAt,
              created_at: listedRepo.latestRelease.createdAt,
            }
          : undefined,
      );
      if (hidden.has(repo)) {
        return { project: project(raw, latestRelease, settingsOf(raw), undefined), pulls: [], releases: [] };
      }
      if (troubled.has(repo)) {
        failed.add(repo);
      }
      /** A part read through the REST API, where GitHub refusing it leaves the part as it was. */
      async function part<T>(reading: () => Promise<T>, fallback: T): Promise<T> {
        try {
          return await reading();
        } catch (error) {
          if (!refused(error)) {
            throw error;
          }
          failed.add(repo);
          return fallback;
        }
      }

      const answer = details.get(repo);
      const was = {
        pulls: previous?.pulls.filter(of(repo)) ?? [],
        releases: previous?.releases.filter(of(repo)) ?? [],
        promoteWorkflow: previous?.projects.find(of(repo))?.promoteWorkflow,
      };
      if (!answer) {
        // Not answered, or never asked because the read stopped short.
        failed.add(repo);
        if (shape[repo]) {
          nextShape[repo] = shape[repo];
        }
        return { project: project(raw, latestRelease, settingsOf(raw), was.promoteWorkflow), ...was };
      }

      const pulls = await part(() => pullsOf(api, repo, answer), was.pulls);

      const paths = wanted(repo);
      const found = paths?.map((path) => ({ path, workflow: workflows.get(flowKey({ repo, path })) }));
      let releases = was.releases;
      let promoteWorkflow = was.promoteWorkflow;
      if (paths && found?.every((one) => one.workflow !== undefined && one.workflow !== "failed")) {
        nextShape[repo] = paths;
        // A disabled workflow starts no more releases, and can't be started.
        const active = found.flatMap(({ path, workflow }) =>
          typeof workflow === "object" && workflow.state === "ACTIVE" ? [{ path, workflow }] : [],
        );
        promoteWorkflow = active.find((one) => one.path === PROMOTE_WORKFLOW)?.workflow.databaseId;
        const names = new Set(releaseFiles(paths, repo, answer, blobOf));
        releasePaths[repo] = [...names];
        const shownOf = active
          .filter((one) => names.has(one.path))
          .map((one) => ({ ...one, ...shown(one.workflow, extraRuns) }));
        if (shownOf.some((one) => one.missing.length > 0)) {
          // A run that is shown couldn't be read in full: the releases stay as they were.
          failed.add(repo);
        } else {
          releases = await part(async () => {
            const runs = await Promise.all(
              shownOf.flatMap(({ path, workflow, runs }) =>
                runs.map((run) => releaseRun(api, repo, path, workflow, run, blobOf)),
              ),
            );
            return runs.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
          }, was.releases);
        }
      } else {
        failed.add(repo);
        if (shape[repo]) {
          nextShape[repo] = shape[repo];
        }
      }
      return { project: project(raw, latestRelease, settingsOf(raw), promoteWorkflow), pulls, releases };
    }),
  );
  return {
    data: {
      projects: read.map((one) => one.project),
      pulls: read.flatMap((one) => one.pulls),
      releases: read.flatMap((one) => one.releases),
    },
    problem: problemOf(failed),
    shape: nextShape,
    releasePaths,
  };
}

type Page<T> = { pageInfo?: { hasNextPage?: boolean; endCursor?: string | null }; nodes?: (T | null)[] };

const flowKey = (flow: Flow) => `${flow.repo}\n${flow.path}`;
const blobKey = (blob: BlobAsk) => `${blob.repo}\n${blob.oid}`;

/** Things to ask for, each only once however often it is added. */
function queue<T>(key: (one: T) => string): { add(one: T): void; take(): T[] } {
  const seen = new Set<string>();
  const waiting: T[] = [];
  return {
    add(one) {
      if (!seen.has(key(one))) {
        seen.add(key(one));
        waiting.push(one);
      }
    },
    take: () => waiting.splice(0),
  };
}

/** The workflow files of a project: the YAML files directly in its workflows folder. */
function workflowFiles(answer: GqlDetails | undefined): GqlEntry[] {
  return (answer?.workflows?.entries ?? []).filter((entry) => entry.type === "blob" && /\.ya?ml$/.test(entry.path));
}

/** Of the paths asked about, the release workflows: all of them but a Promote workflow that isn't one itself. */
function releaseFiles(
  paths: string[],
  repo: string,
  answer: GqlDetails,
  blobOf: (repo: string, oid: string) => WorkflowBlob | undefined,
): string[] {
  const files = workflowFiles(answer).map((file) => ({ path: file.path, blob: blobOf(repo, file.oid) }));
  const anyMarked = files.some((file) => file.blob?.marked);
  return paths.filter((path) => {
    const blob = files.find((file) => file.path === path)?.blob;
    return anyMarked ? blob?.marked : isReleaseName(blob?.name ?? path);
  });
}

/** Whether a run is over, by its check suite's status. */
function isFinished(status: string | null | undefined): boolean {
  return status === "COMPLETED";
}

/**
 * Of a workflow's latest runs, the ones the page shows, as far as they were read: a finished one as its card shows
 * it, which for the latest came with the workflow; one that is going with its jobs, which it has once it was asked
 * for by itself and is in `extra`. `missing` are the ones still to ask for.
 */
function shown(
  workflow: GqlWorkflow | "none" | "failed" | undefined,
  extra: Map<string, GqlRun | undefined>,
): { runs: GqlRun[]; missing: { id: string; going: boolean }[] } {
  const runs: GqlRun[] = [];
  const missing: { id: string; going: boolean }[] = [];
  if (typeof workflow !== "object") {
    return { runs, missing };
  }
  const recent = (workflow.recent?.nodes ?? []).filter((run) => run !== null);
  const picked = shownRuns(
    recent.map((run) => ({ id: run.databaseId, status: lower(run.checkSuite?.status), node: run })),
  );
  for (const { node } of picked) {
    const going = !isFinished(node.checkSuite?.status);
    const full = going
      ? extra.get(node.id)
      : (workflow.runs.nodes.find((run) => run?.id === node.id) ?? extra.get(node.id));
    if (full) {
      runs.push(full);
    } else {
      missing.push({ id: node.id, going });
    }
  }
  return { runs, missing };
}

function lower(word: string | null | undefined): string | null {
  return word?.toLowerCase() ?? null;
}

/** GraphQL leaves the `[bot]` off an app's name, which the REST API and github.com have. */
function login(actor: NonNullable<GqlActor>): string {
  return actor.__typename === "Bot" ? `${actor.login}[bot]` : actor.login;
}

function rawRepo(repo: GqlRepo): RawRepo {
  return {
    full_name: repo.nameWithOwner,
    name: repo.name,
    html_url: repo.url,
    private: repo.isPrivate,
    archived: false,
    pushed_at: repo.pushedAt,
    allow_merge_commit: repo.mergeCommitAllowed,
    allow_squash_merge: repo.squashMergeAllowed,
    allow_rebase_merge: repo.rebaseMergeAllowed,
    allow_auto_merge: repo.autoMergeAllowed,
  };
}

/** The project's open pull requests. What didn't fit into the answer is read the way a read of changes reads it. */
async function pullsOf(api: ReturnType<typeof createApi>, repo: string, answer: GqlDetails): Promise<PullRequest[]> {
  if (answer.pullRequests.pageInfo.hasNextPage) {
    return pullRequests(api, repo);
  }
  const pulls = await Promise.all(
    answer.pullRequests.nodes
      .filter((pull) => pull !== null)
      .map((pull) =>
        pull.statusCheckRollup?.contexts.pageInfo.hasNextPage
          ? pullRequest(api, repo, pull.number)
          : pullFrom(repo, pull),
      ),
  );
  return pulls.filter((pull) => pull !== undefined);
}

function pullFrom(repo: string, pull: GqlPull): PullRequest {
  const raw: RawPull = {
    number: pull.number,
    state: "open",
    title: pull.title,
    html_url: pull.url,
    user: pull.author && {
      login: login(pull.author),
      ...(pull.author.avatarUrl ? { avatar_url: pull.author.avatarUrl } : {}),
    },
    draft: pull.isDraft,
    head: { ref: pull.headRefName, sha: pull.headRefOid },
    base: { ref: pull.baseRefName },
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    // GitHub works mergeability out in the background; until then it is UNKNOWN.
    mergeable: pull.mergeable === "MERGEABLE" ? true : pull.mergeable === "CONFLICTING" ? false : null,
    mergeable_state: pull.mergeStateStatus.toLowerCase(),
    auto_merge: pull.autoMergeRequest,
    node_id: pull.id,
  };
  const checkRuns: RawCheckRun[] = [];
  const statuses: RawStatus[] = [];
  const contexts = pull.statusCheckRollup?.contexts.nodes ?? [];
  // The newest check run first, as the REST API lists them, so that the checks keep their places whichever way
  // they were read last.
  const newestFirst = contexts
    .filter((context) => context?.__typename === "CheckRun")
    .sort((a, b) => (b.databaseId ?? 0) - (a.databaseId ?? 0));
  for (const context of [...newestFirst, ...contexts.filter((context) => context?.__typename !== "CheckRun")]) {
    if (context?.__typename === "CheckRun") {
      checkRuns.push({
        name: context.name,
        status: context.status.toLowerCase(),
        conclusion: lower(context.conclusion),
        html_url: context.permalink,
      });
    } else if (context?.__typename === "StatusContext") {
      // EXPECTED is a required status nobody has reported yet, which is as good as pending.
      const state = context.state === "EXPECTED" ? "pending" : context.state.toLowerCase();
      statuses.push({ context: context.context, state, target_url: context.targetUrl });
    }
  }
  return pullOf(repo, raw, checkRuns, statuses);
}

async function releaseRun(
  api: ReturnType<typeof createApi>,
  repo: string,
  path: string,
  workflow: GqlWorkflow,
  run: GqlRun,
  blobOf: (repo: string, oid: string) => WorkflowBlob | undefined,
): Promise<ReleaseRun> {
  const suite = run.checkSuite;
  const raw: RawRun = {
    id: run.databaseId,
    name: workflow.name,
    ...(run.displayTitle ? { display_title: run.displayTitle } : {}),
    head_branch: suite?.branch?.name ?? null,
    event: run.event,
    html_url: run.url,
    status: lower(suite?.status),
    conclusion: lower(suite?.conclusion),
    triggering_actor: suite?.creator ? { login: login(suite.creator) } : null,
    created_at: run.createdAt,
    updated_at: run.updatedAt,
    ...(suite?.commit ? { head_sha: suite.commit.oid } : {}),
    path,
  };
  // A finished run shows as a link to it on GitHub; its jobs weren't asked for.
  if (isFinished(suite?.status) || suite?.checkRuns === undefined) {
    return runOf(repo, workflow, raw, [], undefined, []);
  }
  const jobs: Job[] = suite?.checkRuns?.pageInfo.hasNextPage
    ? (await runJobs(api, repo, run.databaseId)).map(job)
    : (suite?.checkRuns?.nodes ?? [])
        .filter((one) => one !== null)
        .map((one) =>
          job({
            id: one.databaseId,
            name: one.name,
            status: one.status.toLowerCase(),
            conclusion: lower(one.conclusion),
            html_url: one.permalink,
            started_at: one.startedAt,
            completed_at: one.completedAt,
          }),
        );
  // Unset when GitHub wouldn't say what the run waits for.
  const pending = run.pendingDeploymentRequests?.nodes;
  const approvals: Approval[] | undefined = jobs.some(isWaiting)
    ? pending
        ?.filter((one) => one !== null)
        .map((one) =>
          approval({
            environment: { id: one.environment.databaseId, name: one.environment.name },
            current_user_can_approve: one.currentUserCanApprove,
          }),
        )
    : [];
  const file = suite?.commit?.file;
  return runOf(repo, workflow, raw, jobs, file ? blobOf(repo, file.oid)?.jobs : undefined, approvals);
}
