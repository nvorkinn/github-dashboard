import type { Auth } from "../auth.ts";
import type { Change, Connect, EventStream } from "./events.ts";

/**
 * What a fake GitHub answers for a path: JSON, or a function for anything else (an error, headers, a delay), which is
 * given the path and the request's body read as JSON.
 */
export type Routes = Record<string, unknown>;

/** A request the fake GitHub was sent: its method, path, and body read as JSON. */
export type SentRequest = { method: string; path: string; body: unknown };

/**
 * An `Auth` whose `github` answers from `routes`, keyed by the path as asked for (query included) or, failing that,
 * the path without its query; a write is keyed by its method and path, such as `PUT repos/o/r/pulls/1/merge`.
 * A GraphQL query (`POST graphql`) without a route of its own is answered from the REST routes, see `answerQuery`.
 * Anything else is a 404. `calls` are the paths asked for so far (see `callOf`), `requests` everything about each, and `peak` the
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
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push(callOf(path, body));
      requests.push({ method, path, body });
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
        return typeof route === "function" ? await route(path, body) : Response.json(route);
      } finally {
        running--;
      }
    },
  };
  return { auth, calls, requests, queries, peak: () => peak };
}

/**
 * How `calls` names a request: by its path, except a GraphQL query of one pull request (read.ts), which is named
 * after the pull request, such as `graphql octo/app#2`, so a test can tell which one was read.
 */
function callOf(path: string, body: unknown): string {
  const query = (body as { query?: unknown } | undefined)?.query;
  const one =
    path === "graphql" && typeof query === "string"
      ? /^\s*p\d*: repository\(owner: "([^"]+)", name: "([^"]+)"\) \{ pullRequest\(number: (\d+)\)/m.exec(query)
      : null;
  return one ? `graphql ${one[1]}/${one[2]}#${one[3]}` : path;
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

const upper = (word: unknown) => (typeof word === "string" ? word.toUpperCase() : null);

/**
 * Answers the dashboard's GraphQL query (graphql.ts) from the same `routes` as the REST API's, so that a test's
 * account is the same whichever way it is read. A route that fails with a rate limit or a 401 fails the whole
 * query with that answer, and so does anything wrong with the list of installations; any other failure fails the
 * field of its repository.
 */
export async function answerQuery(routes: Routes, query: string): Promise<Response> {
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
        defaultBranchRef: one.default_branch ? { name: one.default_branch } : null,
      });
    }
    nodes.sort((a, b) => (b.pushedAt ?? "").localeCompare(a.pushedAt ?? ""));
    return { repositories: { pageInfo: { hasNextPage: false, endCursor: null }, nodes } };
  }

  async function pullOf(repo: string, number: number): Promise<Json> {
    const one = await get(`repos/${repo}/pulls/${number}`);
    return one?.state === "open" ? nodeOf(repo, one) : undefined;
  }

  /** A pull request as the fragment `Pull` has it, from the REST routes of it and its head's checks. */
  async function nodeOf(repo: string, one: Json): Promise<Json> {
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
      commits: { totalCount: one.commits ?? 1 },
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

  async function details(repo: string): Promise<Json> {
    const open: Json[] = (await get(`repos/${repo}/pulls`)) ?? [];
    const pulls = await Promise.all(open.map((one) => pullOf(repo, one.number)));
    return { pullRequests: { pageInfo: { hasNextPage: false }, nodes: pulls.filter((one) => one !== undefined) } };
  }

  /**
   * The comparison of a release's tag with a branch, from the REST route of the same comparison: its `ahead_by`
   * commits, each with the pull request `merged` numbers for it, if any. No route is a tag that isn't there.
   */
  async function comparison(repo: string, tag: string, branch: string): Promise<Json> {
    const found = await get(`repos/${repo}/compare/${tag}...${branch}`);
    if (found === undefined) {
      return { ref: null };
    }
    const nodes = Array.from({ length: Math.min(found.ahead_by, 100) }, (_, index) => {
      const number = found.merged?.[index];
      return {
        associatedPullRequests: {
          nodes: typeof number === "number" ? [{ number, merged: true, baseRefName: branch }] : [],
        },
      };
    });
    return { ref: { compare: { aheadBy: found.ahead_by, commits: { nodes } } } };
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
    for (const [, alias, owner, name] of query.matchAll(
      /^\s*(r\d+): repository\(owner: "([^"]+)", name: "([^"]+)"\) \{ \.\.\.Pulls/gm,
    )) {
      await field(alias ?? "", () => details(`${owner}/${name}`));
    }
    for (const [, alias, owner, name, number] of query.matchAll(
      /^\s*(p\d*): repository\(owner: "([^"]+)", name: "([^"]+)"\) \{ pullRequest\(number: (\d+)\)/gm,
    )) {
      await field(alias ?? "", async () => {
        const one = await get(`repos/${owner}/${name}/pulls/${number}`);
        if (one === undefined) {
          errors.push({ type: "NOT_FOUND", path: [alias, "pullRequest"], message: "Could not resolve" });
          return { pullRequest: null };
        }
        return { pullRequest: { state: upper(one.state), ...(await nodeOf(`${owner}/${name}`, one)) } };
      });
    }
    for (const [, alias, owner, name] of query.matchAll(
      /^\s*(h\d+): repository\(owner: "([^"]+)", name: "([^"]+)"\) \{ pullRequests\(/gm,
    )) {
      await field(alias ?? "", async () => {
        const open: Json[] | undefined = await get(`repos/${owner}/${name}/pulls`);
        if (open === undefined) {
          errors.push({ type: "NOT_FOUND", path: [alias], message: "Could not resolve to a Repository" });
          return null;
        }
        return {
          pullRequests: { nodes: open.map((one) => ({ number: one.number, title: one.title, url: one.html_url })) },
        };
      });
    }
    for (const [, alias, owner, name, tag, branch] of query.matchAll(
      /^\s*(c\d+): repository\(owner: "([^"]+)", name: "([^"]+)"\) \{ ref\(qualifiedName: "refs\/tags\/([^"]+)"\) \{ compare\(headRef: "([^"]+)"\)/gm,
    )) {
      await field(alias ?? "", () => comparison(`${owner}/${name}`, tag ?? "", branch ?? ""));
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
