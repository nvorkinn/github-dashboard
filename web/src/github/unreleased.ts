/**
 * What a project's default branch has that its latest release hasn't, read from GitHub's comparison of the two
 * through the GraphQL API, which says of each commit the pull requests it came in with.
 */
import type { Unreleased } from "../model.ts";

// How many commits of a comparison are read. Of one with more, only the commits are counted.
export const COMMITS_PER_COMPARISON = 100;
// A commit nearly always came in with one pull request; a few more for one that went through a stack of them.
const PULLS_PER_COMMIT = 5;

type GqlPullRef = { number: number; merged: boolean; baseRefName: string };
/** The answer to `comparisonField`. */
export type GqlComparison =
  | {
      ref?: {
        compare?: {
          aheadBy?: number;
          commits?: { nodes?: ({ associatedPullRequests?: { nodes?: (GqlPullRef | null)[] } | null } | null)[] } | null;
        } | null;
      } | null;
    }
  | null
  | undefined;

/** The query field that compares the release `tag` of `repo` with its `branch`. */
export function comparisonField(repo: string, tag: string, branch: string): string {
  const [owner = "", name = ""] = repo.split("/");
  const quoted = (text: string) => JSON.stringify(text);
  return `repository(owner: ${quoted(owner)}, name: ${quoted(name)}) { ref(qualifiedName: ${quoted(`refs/tags/${tag}`)}) { compare(headRef: ${quoted(branch)}) {
    aheadBy
    commits(first: ${COMMITS_PER_COMPARISON}) { nodes { associatedPullRequests(first: ${PULLS_PER_COMMIT}) { nodes { number merged baseRefName } } } }
  } } }`;
}

/**
 * What the comparison says: the commits `branch` is ahead by, and the pull requests merged into it that they came
 * in with. Undefined when there is nothing to compare, such as a release whose tag is gone.
 */
export function unreleasedFrom(answer: GqlComparison, branch: string): Unreleased | undefined {
  const compare = answer?.ref?.compare;
  const commits = compare?.aheadBy;
  if (typeof commits !== "number") {
    return undefined;
  }
  const nodes = compare?.commits?.nodes;
  if (!Array.isArray(nodes) || nodes.length < commits) {
    // Not every commit was read, so the pull requests can't be counted.
    return { commits, pulls: undefined };
  }
  const pulls = new Set<number>();
  for (const commit of nodes) {
    for (const pull of commit?.associatedPullRequests?.nodes ?? []) {
      if (pull?.merged && pull.baseRefName === branch) {
        pulls.add(pull.number);
      }
    }
  }
  return { commits, pulls: pulls.size };
}
