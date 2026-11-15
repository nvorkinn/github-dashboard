import { AppError, type GitHubApp } from "./github_app.ts";

/** A workflow file's text as GitHub's blobs API gives it. */
export function blob(text: string) {
  return { encoding: "base64", content: Buffer.from(text).toString("base64") };
}

/**
 * A GitHub App client for tests: `routes` says what each path answers, a number being the status it fails with, and
 * can be changed between reads. A path nothing is said of fails with 404. `calls` are the paths read, in order.
 * A GraphQL query is answered by `routes.graphql`, a function of the query and its variables that gives the data or
 * a status to fail with; its call is `graphql`.
 */
export function fakeApp(repositories: { repo: string; defaultBranch?: string }[], routes: Record<string, unknown>) {
  const calls: string[] = [];
  function answer(path: string): unknown {
    calls.push(path);
    const found = Object.hasOwn(routes, path) ? routes[path] : 404;
    if (typeof found === "number") {
      throw new AppError(found, `HTTP ${found}`);
    }
    return found;
  }
  const app: GitHubApp = {
    repositories: async () =>
      repositories.map((one) => ({ repo: one.repo, installation: 1, defaultBranch: one.defaultBranch ?? "main" })),
    get: async <T>(_installation: number, path: string) => answer(path) as T,
    list: async <T>(_installation: number, path: string, key?: string) => {
      const found = answer(path);
      return (key === undefined ? found : (found as Record<string, unknown>)[key]) as T[];
    },
    query: async (_installation: number, query: string, variables?: Record<string, unknown>) => {
      calls.push("graphql");
      const answer = routes.graphql as ((query: string, variables: Record<string, unknown>) => unknown) | undefined;
      const found = answer ? await answer(query, variables ?? {}) : 404;
      if (typeof found === "number") {
        throw new AppError(found, `HTTP ${found}`);
      }
      return { data: found as Record<string, unknown>, errors: [] };
    },
  };
  return { app, calls, routes, repositories };
}

/** Lets everything that is already on its way finish: reads the fakes answer at once, and what follows from them. */
export async function settle(): Promise<void> {
  for (let turn = 0; turn < 50; turn++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/** Waits until `done` says so, for what takes real time, such as signing a token. */
export async function until(done: () => boolean): Promise<void> {
  for (let turn = 0; turn < 500 && !done(); turn++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  if (!done()) {
    throw new Error("It never happened");
  }
}
