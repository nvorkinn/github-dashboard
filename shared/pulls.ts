/**
 * Whether a pull request can be merged, in the words the page shows, and how the relay tells the page of it.
 */

/** `unknown` while GitHub is still working it out, which it does in the background and only when asked. */
export type MergeState = "clean" | "blocked" | "conflicts" | "behind" | "unknown";

/**
 * GitHub's `mergeable_state` (REST) in the model's words. `has_hooks` is mergeable with pre-receive hooks to pass, and
 * `unstable` is mergeable with checks that failed but aren't required, so both are `clean`: the checks show the
 * failure themselves. A draft can't be merged until it is marked ready, so it is `blocked`.
 */
export function mergeState(pull: { mergeable?: boolean | null; mergeable_state?: string }): MergeState {
  // GitHub works mergeability out in the background; until then `mergeable` is null.
  if (pull.mergeable == null) {
    return "unknown";
  }
  switch (pull.mergeable_state) {
    case "clean":
    case "has_hooks":
    case "unstable":
      return "clean";
    case "dirty":
      return "conflicts";
    case "behind":
      return "behind";
    case "blocked":
    case "draft":
      return "blocked";
    default:
      return "unknown";
  }
}

/** GitHub's GraphQL `mergeable` (MERGEABLE, CONFLICTING, UNKNOWN) and `mergeStateStatus` in the model's words. */
export function mergeStateOf(mergeable: string, mergeStateStatus: string): MergeState {
  return mergeState({
    mergeable: mergeable === "MERGEABLE" ? true : mergeable === "CONFLICTING" ? false : null,
    mergeable_state: mergeStateStatus.toLowerCase(),
  });
}

/**
 * What the relay tells the pages after a push to `base` (see relay/src/merge_states.ts): the merge states of open
 * pull requests into it, each at the head it was worked out for.
 */
export type MergeUpdate = {
  /** `owner/name`. */
  repo: string;
  /** The branch that was pushed to: the pull requests' base. */
  base: string;
  pulls: { number: number; sha: string; mergeState: MergeState }[];
};

export const MERGE_STATES: readonly MergeState[] = ["clean", "blocked", "conflicts", "behind", "unknown"];
