import type { Auth } from "../auth.ts";

/** What a fake GitHub answers for a path: JSON, or a function for anything else (an error, headers, a delay). */
export type Routes = Record<string, unknown>;

/**
 * An `Auth` whose `github` answers from `routes`, keyed by the path as asked for (query included) or, failing that,
 * the path without its query. Anything else is a 404. `calls` are the paths asked for so far and `peak` the most
 * requests that were under way at once.
 */
export function fakeGitHub(routes: Routes): { auth: Auth; calls: string[]; peak: () => number } {
  const calls: string[] = [];
  let running = 0;
  let peak = 0;
  const auth: Auth = {
    state: () => ({ status: "signedIn" }),
    subscribe: () => () => {},
    start: async () => {},
    signOut: async () => true,
    async github(path) {
      calls.push(path);
      running++;
      peak = Math.max(peak, running);
      try {
        const route = path in routes ? routes[path] : routes[path.split("?")[0] ?? path];
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
  return { auth, calls, peak: () => peak };
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
  workflow: { id: number; name: string; state?: string },
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
