import type { Auth } from "../auth.ts";
import type { Change, Connect, EventStream } from "./events.ts";

/** What a fake GitHub answers for a path: JSON, or a function for anything else (an error, headers, a delay). */
export type Routes = Record<string, unknown>;

/** A request the fake GitHub was sent: its method, path, and body read as JSON. */
export type SentRequest = { method: string; path: string; body: unknown };

/**
 * An `Auth` whose `github` answers from `routes`, keyed by the path as asked for (query included) or, failing that,
 * the path without its query; a write is keyed by its method and path, such as `PUT repos/o/r/pulls/1/merge`.
 * A GraphQL query (`POST graphql`) without a route of its own is answered from the REST routes, see `answerQuery`.
 * Anything else is a 404. `calls` are the paths asked for so far, `requests` everything about each, and `peak` the
 * most requests that were under way at once.
 */
export function fakeGitHub(routes: Routes): {
  auth: Auth;
  calls: string[];
  requests: SentRequest[];
  /** The GraphQL queries the fake answered from `routes`, as text. */
  queries: string[];
  peak: () => number;
} {
  const queries: string[] = [];
  const calls: string[] = [];
  const requests: SentRequest[] = [];
  let running = 0;
  let peak = 0;
  const auth: Auth = {
    state: () => ({ status: "signedIn" }),
    subscribe: () => () => {},
    start: async () => {},
    signOut: async () => true,
    async github(path, init) {
      calls.push(path);
      const method = init?.method ?? "GET";
      requests.push({ method, path, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      running++;
      peak = Math.max(peak, running);
      try {
        const key = method === "GET" ? path : `${method} ${path}`;
        const route = key in routes ? routes[key] : routes[key.split("?")[0] ?? key];
        const query = (requests.at(-1)?.body as { query?: unknown } | undefined)?.query;
        if (route === undefined && key === "POST graphql" && typeof query === "string" && query.startsWith("query")) {
          queries.push(query);
          await new Promise((resolve) => setImmediate(resolve));
          return await answerQuery(routes, query);
        }
        if (route === undefined) {
          return Response.json({ message: "Not Found" }, { status: 404 });
        }
        // A real answer takes a moment, during which other requests start.
        await new Promise((resolve) => setImmediate(resolve));
        return typeof route === "function" ? await route(path) : Response.json(route);
      } finally {
        running--;
      }
    },
  };
  return { auth, calls, requests, queries, peak: () => peak };
}

/** Ends the answering of a query with an HTTP answer of its own, as GitHub does for what fails every call. */
class Whole {
  response: Response;
  constructor(response: Response) {
    this.response = response;
  }
}

/** Fails one field of a query, as GitHub does for what it won't say of one repository. */
class Refused {}

const hex = (text: string) => Buffer.from(text, "utf8").toString("hex");
const upper = (word: unknown) => (typeof word === "string" ? word.toUpperCase() : null);

/**
 * Answers the dashboard's GraphQL query (graphql.ts) from the same `routes` as the REST API's, so that a test's
 * account is the same whichever way it is read. A route that fails with a rate limit or a 401 fails the whole
 * query with that answer, and so does anything wrong with the list of installations; any other failure fails the
 * field of its repository or workflow. A workflow file's id is its text in hex.
 */
async function answerQuery(routes: Routes, query: string): Promise<Response> {
  // biome-ignore lint/suspicious/noExplicitAny: answers shaped like GitHub's, as loosely typed as its JSON.
  type Json = any;
  /** A route's JSON; undefined for one that isn't there. */
  async function get(path: string, whole = false): Promise<Json> {
    const route = path in routes ? routes[path] : routes[path.split("?")[0] ?? path];
    if (route === undefined) {
      return undefined;
    }
    if (typeof route !== "function") {
      return route;
    }
    const response: Response = await route(path);
    if (response.ok) {
      return response.json();
    }
    const limited = response.headers.has("retry-after") || response.headers.get("x-ratelimit-remaining") === "0";
    if (whole || response.status === 401 || response.status === 429 || limited) {
      throw new Whole(response);
    }
    throw new Refused();
  }
  const text = (blob: Json): string =>
    blob?.encoding === "base64" ? Buffer.from(String(blob.content), "base64").toString("utf8") : "";
  const blobOf = (content: string, withText: boolean) => ({
    oid: hex(content),
    ...(withText ? { object: { text: content } } : {}),
  });

  async function listed(): Promise<Json> {
    const installations = (await get("user/installations", true))?.installations ?? [];
    const repos = new Map<string, Json>();
    for (const installation of installations) {
      for (const one of (await get(`user/installations/${installation.id}/repositories`, true))?.repositories ?? []) {
        if (!one.archived) {
          repos.set(one.full_name, one);
        }
      }
    }
    const nodes = [];
    for (const one of repos.values()) {
      const own = typeof routes[`repos/${one.full_name}`] === "function" ? {} : routes[`repos/${one.full_name}`];
      const settings: Json = { ...(own as object), ...one };
      const release = await get(`repos/${one.full_name}/releases/latest`).catch(() => undefined);
      nodes.push({
        nameWithOwner: one.full_name,
        name: one.name,
        description: one.description,
        url: one.html_url,
        isPrivate: one.private,
        pushedAt: one.pushed_at,
        mergeCommitAllowed: settings.allow_merge_commit ?? true,
        squashMergeAllowed: settings.allow_squash_merge ?? true,
        rebaseMergeAllowed: settings.allow_rebase_merge ?? true,
        autoMergeAllowed: settings.allow_auto_merge ?? true,
        latestRelease: release
          ? {
              tagName: release.tag_name,
              url: release.html_url,
              publishedAt: release.published_at,
              createdAt: release.created_at,
            }
          : null,
      });
    }
    nodes.sort((a, b) => (b.pushedAt ?? "").localeCompare(a.pushedAt ?? ""));
    return { repositories: { pageInfo: { hasNextPage: false, endCursor: null }, nodes } };
  }

  async function pullOf(repo: string, number: number): Promise<Json> {
    const one = await get(`repos/${repo}/pulls/${number}`);
    if (one?.state !== "open") {
      return undefined;
    }
    const checkRuns = (await get(`repos/${repo}/commits/${one.head.sha}/check-runs`))?.check_runs ?? [];
    const seen = new Set<string>();
    const statuses = ((await get(`repos/${repo}/commits/${one.head.sha}/statuses`)) ?? []).filter(
      (status: Json) => !seen.has(status.context) && seen.add(status.context),
    );
    const bot = typeof one.user?.login === "string" && one.user.login.endsWith("[bot]");
    return {
      id: one.node_id,
      number: one.number,
      title: one.title,
      url: one.html_url,
      isDraft: one.draft ?? false,
      headRefName: one.head.ref,
      baseRefName: one.base.ref,
      headRefOid: one.head.sha,
      createdAt: one.created_at,
      updatedAt: one.updated_at,
      mergeable: one.mergeable == null ? "UNKNOWN" : one.mergeable ? "MERGEABLE" : "CONFLICTING",
      mergeStateStatus: one.mergeable_state === "draft" ? "BLOCKED" : (upper(one.mergeable_state) ?? "UNKNOWN"),
      autoMergeRequest: one.auto_merge ? { enabledAt: "2026-11-02T09:00:00Z" } : null,
      author: one.user && {
        __typename: bot ? "Bot" : "User",
        login: bot ? one.user.login.slice(0, -"[bot]".length) : one.user.login,
        avatarUrl: one.user.avatar_url,
      },
      statusCheckRollup: {
        contexts: {
          pageInfo: { hasNextPage: false },
          nodes: [
            ...checkRuns.map((run: Json) => ({
              __typename: "CheckRun",
              databaseId: run.id ?? null,
              name: run.name,
              status: upper(run.status),
              conclusion: upper(run.conclusion),
              permalink: run.html_url,
            })),
            ...statuses.map((status: Json) => ({
              __typename: "StatusContext",
              context: status.context,
              state: upper(status.state),
              targetUrl: status.target_url,
            })),
          ],
        },
      },
    };
  }

  /** The repository's workflow files: the folder as listed if a test listed it, else a file per workflow. */
  async function entries(repo: string, withText: boolean): Promise<Json[] | undefined> {
    const folder = await get(`repos/${repo}/contents/.github/workflows`).catch(() => undefined);
    if (Array.isArray(folder)) {
      return Promise.all(
        folder.map(async (entry: Json) => ({
          path: entry.path,
          type: entry.type === "file" ? "blob" : "tree",
          ...blobOf(text(await get(`repos/${repo}/git/blobs/${entry.sha}`)), withText),
        })),
      );
    }
    const workflows: Json[] = (await get(`repos/${repo}/actions/workflows`))?.workflows ?? [];
    const files = workflows.filter((one) => String(one.path).startsWith(".github/workflows/"));
    return files.length === 0
      ? undefined
      : files.map((one) => ({ path: one.path, type: "blob", ...blobOf(`name: ${one.name}\n`, withText) }));
  }

  async function details(repo: string, withText: boolean): Promise<Json> {
    const open: Json[] = (await get(`repos/${repo}/pulls`)) ?? [];
    const pulls = await Promise.all(open.map((one) => pullOf(repo, one.number)));
    const files = await entries(repo, withText);
    return {
      workflows: files ? { entries: files } : null,
      pullRequests: { pageInfo: { hasNextPage: false }, nodes: pulls.filter((one) => one !== undefined) },
    };
  }

  /** A run's node id, which says where the fake finds it again. */
  const runId = (repo: string, workflowId: number, run: Json) => `RUN:${repo}:${workflowId}:${run.id}`;

  async function runsOf(repo: string, workflowId: number): Promise<Json[]> {
    return (await get(`repos/${repo}/actions/workflows/${workflowId}/runs`))?.workflow_runs ?? [];
  }

  async function workflow(repo: string, path: string, withText: boolean): Promise<Json> {
    const workflows: Json[] = (await get(`repos/${repo}/actions/workflows`))?.workflows ?? [];
    const found = workflows.find((one) => one.path === path);
    if (!found) {
      return null;
    }
    const runs = (await runsOf(repo, found.id)).slice(0, 5);
    return {
      databaseId: found.id,
      name: found.name,
      state: upper(found.state),
      recent: {
        nodes: runs.map((run) => ({
          id: runId(repo, found.id, run),
          databaseId: run.id,
          checkSuite: { status: upper(run.status) },
        })),
      },
      runs: { nodes: await Promise.all(runs.slice(0, 1).map((run) => runNode(repo, found.id, path, run, withText))) },
    };
  }

  /** One run in full, asked for by its node id. */
  async function runById(id: string, path: string, withText: boolean): Promise<Json> {
    const [, repo = "", workflowId = "", number = ""] = id.split(":");
    const run = (await runsOf(repo, Number(workflowId))).find((one) => String(one.id) === number);
    return run ? runNode(repo, Number(workflowId), path, run, withText) : null;
  }

  async function runNode(repo: string, workflowId: number, path: string, run: Json, withText: boolean): Promise<Json> {
    {
      const jobs: Json[] = (await get(`repos/${repo}/actions/runs/${run.id}/jobs`))?.jobs ?? [];
      const pending: Json[] =
        (await get(`repos/${repo}/actions/runs/${run.id}/pending_deployments`).catch((error) => {
          if (error instanceof Whole) {
            throw error;
          }
          return [];
        })) ?? [];
      const file = run.head_sha
        ? await get(`repos/${repo}/contents/${path}?ref=${run.head_sha}`).catch(() => undefined)
        : undefined;
      const actor = run.triggering_actor ?? run.actor;
      return {
        id: runId(repo, workflowId, run),
        databaseId: run.id,
        displayTitle: run.display_title ?? null,
        event: run.event,
        url: run.html_url,
        createdAt: run.created_at,
        updatedAt: run.updated_at,
        pendingDeploymentRequests: {
          nodes: pending.map((one) => ({
            currentUserCanApprove: one.current_user_can_approve,
            environment: { databaseId: one.environment.id, name: one.environment.name },
          })),
        },
        checkSuite: {
          status: upper(run.status),
          conclusion: upper(run.conclusion),
          branch: run.head_branch ? { name: run.head_branch } : null,
          creator: actor ? { __typename: "User", login: actor.login } : null,
          commit: { oid: run.head_sha ?? `head${run.id}`, file: file ? blobOf(text(file), withText) : null },
          checkRuns: {
            pageInfo: { hasNextPage: false },
            nodes: jobs.map((one) => ({
              databaseId: one.id,
              name: one.name,
              status: upper(one.status),
              conclusion: upper(one.conclusion),
              permalink: one.html_url,
              startedAt: one.started_at,
              completedAt: one.completed_at,
            })),
          },
        },
      };
    }
  }

  const data: Record<string, unknown> = {};
  const errors: unknown[] = [];
  async function field(name: string, answer: () => Promise<unknown>): Promise<void> {
    try {
      data[name] = await answer();
    } catch (error) {
      if (!(error instanceof Refused)) {
        throw error;
      }
      data[name] = null;
      errors.push({ type: "SERVICE_UNAVAILABLE", path: [name], message: "Something went wrong" });
    }
  }
  try {
    if (/^\s*viewer \{/m.test(query)) {
      data.viewer = await listed();
    }
    const treeText = query.includes("entries { path type oid object");
    for (const [, alias, owner, name] of query.matchAll(
      /^\s*(r\d+): repository\(owner: "([^"]+)", name: "([^"]+)"\) \{\s*workflows:/gm,
    )) {
      await field(alias ?? "", () => details(`${owner}/${name}`, treeText));
    }
    for (const [, alias, repo, file, more] of query.matchAll(
      /^\s*(w\d+): resource\(url: "https:\/\/github\.com\/([^/"]+\/[^/"]+)\/actions\/workflows\/([^"]+)"\)([\s\S]*?)\n {2}\} \}/gm,
    )) {
      const path = `.github/workflows/${decodeURIComponent(file ?? "")}`;
      await field(alias ?? "", () => workflow(repo ?? "", path, (more ?? "").includes("{ oid object")));
    }
    for (const [, alias, id, path, more] of query.matchAll(
      /^\s*(n\d+): node\(id: "([^"]+)"\)[^\n]*file\(path: "([^"]+)"\) \{ oid( object)?/gm,
    )) {
      await field(alias ?? "", () => runById(id ?? "", path ?? "", more !== undefined));
    }
    for (const [, alias, oid] of query.matchAll(/^\s*(b\d+): repository\([^)]*\) \{ object\(oid: "([0-9a-f]*)"\)/gm)) {
      data[alias ?? ""] = { object: { text: Buffer.from(oid ?? "", "hex").toString("utf8") } };
    }
  } catch (error) {
    if (error instanceof Whole) {
      return error.response;
    }
    throw error;
  }
  return Response.json(errors.length > 0 ? { data, errors } : { data });
}

// Answers shaped like GitHub's, cut down to what the dashboard reads plus a little it must ignore.

export function repo(fullName: string, more: Record<string, unknown> = {}) {
  const [owner, name] = fullName.split("/");
  return {
    id: 1,
    name,
    full_name: fullName,
    owner: { login: owner },
    private: false,
    html_url: `https://github.com/${fullName}`,
    description: "A sample",
    archived: false,
    pushed_at: "2026-11-01T10:00:00Z",
    default_branch: "main",
    ...more,
  };
}

export function pull(fullName: string, number: number, more: Record<string, unknown> = {}) {
  return {
    number,
    state: "open",
    title: `Change ${number}`,
    html_url: `https://github.com/${fullName}/pull/${number}`,
    user: { login: "octocat", avatar_url: "https://avatars.githubusercontent.com/u/583231" },
    draft: false,
    head: { ref: `change-${number}`, sha: `sha${number}` },
    base: { ref: "main" },
    created_at: "2026-11-02T08:00:00Z",
    updated_at: "2026-11-02T09:00:00Z",
    mergeable: true,
    mergeable_state: "clean",
    auto_merge: null,
    node_id: `PR_node${number}`,
    ...more,
  };
}

export function run(fullName: string, id: number, more: Record<string, unknown> = {}) {
  return {
    id,
    name: "Release",
    display_title: `v1.0.${id}`,
    html_url: `https://github.com/${fullName}/actions/runs/${id}`,
    status: "completed",
    conclusion: "success",
    event: "push",
    actor: { login: "octocat" },
    triggering_actor: { login: "octocat" },
    created_at: `2026-11-0${id}T12:00:00Z`,
    run_started_at: `2026-11-0${id}T12:00:05Z`,
    updated_at: `2026-11-0${id}T12:10:00Z`,
    ...more,
  };
}

export function job(id: number, more: Record<string, unknown> = {}) {
  return {
    id,
    name: `job ${id}`,
    status: "completed",
    conclusion: "success",
    html_url: `https://github.com/octo/app/actions/runs/1/job/${id}`,
    started_at: "2026-11-01T12:00:10Z",
    completed_at: "2026-11-01T12:05:00Z",
    steps: [],
    ...more,
  };
}

/** The routes of an account with these repositories and nothing in them. */
export function account(...fullNames: string[]): Routes {
  const routes: Routes = {
    "user/installations": { total_count: 1, installations: [{ id: 7, account: { login: "octo" } }] },
    "user/installations/7/repositories": {
      total_count: fullNames.length,
      repositories: fullNames.map((name) => repo(name)),
    },
  };
  for (const name of fullNames) {
    // Its own page has the merge settings, which the list leaves out.
    routes[`repos/${name}`] = repo(name, {
      allow_merge_commit: true,
      allow_squash_merge: true,
      allow_rebase_merge: true,
      allow_auto_merge: true,
    });
    routes[`repos/${name}/pulls`] = [];
    routes[`repos/${name}/actions/workflows`] = { total_count: 0, workflows: [] };
  }
  return routes;
}

/** Adds an open pull request and its checks to `routes`. */
export function withPull(
  routes: Routes,
  fullName: string,
  number: number,
  more: { pull?: Record<string, unknown>; checkRuns?: unknown[]; statuses?: unknown[] } = {},
): void {
  const one = pull(fullName, number, more.pull);
  routes[`repos/${fullName}/pulls`] = [...(routes[`repos/${fullName}/pulls`] as unknown[]), one];
  routes[`repos/${fullName}/pulls/${number}`] = one;
  routes[`repos/${fullName}/commits/${one.head.sha}/check-runs`] = {
    total_count: more.checkRuns?.length ?? 0,
    check_runs: more.checkRuns ?? [],
  };
  routes[`repos/${fullName}/commits/${one.head.sha}/statuses`] = more.statuses ?? [];
}

/** Adds a workflow with these latest runs (newest first), each with these jobs, to `routes`. */
export function withWorkflow(
  routes: Routes,
  fullName: string,
  workflow: { id: number; name: string; state?: string; path?: string },
  runs: { id: number; jobs?: unknown[]; [key: string]: unknown }[],
): void {
  const list = routes[`repos/${fullName}/actions/workflows`] as { workflows: unknown[] };
  list.workflows.push({ state: "active", path: `.github/workflows/${workflow.id}.yml`, ...workflow });
  routes[`repos/${fullName}/actions/workflows/${workflow.id}/runs`] = {
    total_count: runs.length,
    workflow_runs: runs.map(({ jobs: _, ...more }) => run(fullName, more.id, { name: workflow.name, ...more })),
  };
  for (const one of runs) {
    routes[`repos/${fullName}/actions/runs/${one.id}/jobs`] = {
      total_count: one.jobs?.length ?? 0,
      jobs: one.jobs ?? [],
    };
  }
}

/** One fake connection to the relay's stream of events. */
export type FakeStream = EventStream & {
  closed: boolean;
  /** Delivers an event, with `data` as the relay would have written it. */
  emit(type: string, data?: string): void;
  /** Delivers a change, as JSON. */
  change(change: Change): void;
};

/** A `Connect` that makes fake streams and keeps them: `last` is the one connected now. */
export function fakeStreams(): { connect: Connect; streams: FakeStream[]; last: () => FakeStream } {
  const streams: FakeStream[] = [];
  return {
    streams,
    connect() {
      const listeners = new Map<string, ((event: Event) => void)[]>();
      const stream: FakeStream = {
        closed: false,
        addEventListener(type, listener) {
          listeners.set(type, [...(listeners.get(type) ?? []), listener]);
        },
        close() {
          stream.closed = true;
        },
        emit(type, data = "{}") {
          for (const listener of listeners.get(type) ?? []) {
            listener(new MessageEvent(type, { data }));
          }
        },
        change(change) {
          stream.emit("change", JSON.stringify(change));
        },
      };
      streams.push(stream);
      return stream;
    },
    last() {
      const stream = streams.at(-1);
      if (!stream) {
        throw new Error("Nothing has connected");
      }
      return stream;
    },
  };
}
