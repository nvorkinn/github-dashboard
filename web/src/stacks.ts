/**
 * Stacked pull requests: one in a GitHub stack, or simply one whose base branch is the head branch of another open
 * pull request of the same project. Such a pull request goes in after the one under it, so the page shows them
 * together, in the order they merge.
 */
import type { PullRequest } from "./model.ts";

const keyOf = (pull: PullRequest) => `${pull.repo}#${pull.number}`;

/** Where one pull request sits in its stack. */
export type StackPlace = {
  /** The open pull request it is based on, which merges first. Undefined for the bottom of a stack. */
  under: PullRequest | undefined;
  /** 1 for the bottom of the stack's open pull requests, the one into the project's branch; counting up from there. */
  position: number;
  /** How many open pull requests the whole stack has. */
  size: number;
  /** The branch the whole stack goes into in the end, such as `main`. */
  into: string;
  /**
   * The open pull requests under it, bottom first. In a GitHub stack (`native`) merging it merges these too;
   * otherwise merging it would only fold it into the branch of the one under it.
   */
  below: PullRequest[];
  native: boolean;
};

/**
 * The place in its stack of every pull request that is in one, by `owner/name#number`. A pull request on its own (not
 * based on another, and with none based on it) isn't in the map.
 */
export function findStacks(pulls: PullRequest[]): Map<string, StackPlace> {
  const byHead = new Map<string, PullRequest>();
  for (const pull of pulls) {
    // Two open pull requests from the one branch can't both be what a third is based on; the first will do.
    const head = `${pull.repo}:${pull.head}`;
    if (!byHead.has(head)) byHead.set(head, pull);
  }
  const byEntry = new Map<string, PullRequest>();
  for (const pull of pulls) {
    if (pull.stack) byEntry.set(`${pull.repo}:${pull.stack.number}:${pull.stack.position}`, pull);
  }
  const underOf = (pull: PullRequest): PullRequest | undefined => {
    // GitHub's own word first; the branches for a stack GitHub doesn't know of.
    const entry = pull.stack;
    const under =
      (entry && byEntry.get(`${pull.repo}:${entry.number}:${entry.position - 1}`)) ??
      byHead.get(`${pull.repo}:${pull.base}`);
    return under && under !== pull ? under : undefined;
  };
  const places = new Map<string, StackPlace>();
  const above = new Map<PullRequest, PullRequest[]>();
  for (const pull of pulls) {
    const under = underOf(pull);
    if (under) above.set(under, [...(above.get(under) ?? []), pull]);
  }
  for (const bottom of pulls) {
    if (underOf(bottom) || !above.has(bottom)) continue;
    const members: { pull: PullRequest; under: PullRequest | undefined; below: PullRequest[] }[] = [];
    const seen = new Set<PullRequest>();
    const walk = (pull: PullRequest, under: PullRequest | undefined, below: PullRequest[]) => {
      if (seen.has(pull)) return;
      seen.add(pull);
      members.push({ pull, under, below });
      for (const next of above.get(pull) ?? []) walk(next, pull, [...below, pull]);
    };
    walk(bottom, undefined, []);
    for (const { pull, under, below } of members) {
      const native = pull.stack !== undefined && below.every((one) => one.stack?.number === pull.stack?.number);
      places.set(keyOf(pull), {
        under,
        below,
        position: below.length + 1,
        size: members.length,
        into: bottom.base,
        native,
      });
    }
  }
  return places;
}

/** What a list shows: a pull request on its own, or a stack of them, bottom first. */
export type PullGroup = { pull: PullRequest } | { stack: PullRequest[]; into: string };

/**
 * The pull requests, in the order given, with each stack drawn together where its first member comes. Within a stack
 * they go bottom first, the order they merge in; ones on the same pull request keep the order given. A stack of which
 * only one member is in `pulls` is that pull request on its own.
 */
export function groupStacks(pulls: PullRequest[], places: Map<string, StackPlace>): PullGroup[] {
  const groups: PullGroup[] = [];
  const done = new Set<PullRequest>();
  const shown = new Set(pulls);
  for (const pull of pulls) {
    if (done.has(pull)) continue;
    const place = places.get(keyOf(pull));
    if (!place) {
      groups.push({ pull });
      continue;
    }
    // Down to the lowest member that is shown, then everything shown above it, depth first.
    let bottom = pull;
    for (let under = place.under; under; under = places.get(keyOf(under))?.under) {
      if (shown.has(under)) bottom = under;
    }
    const stack: PullRequest[] = [];
    const add = (one: PullRequest) => {
      if (done.has(one)) return;
      if (shown.has(one)) {
        done.add(one);
        stack.push(one);
      }
      for (const next of pulls.filter((other) => places.get(keyOf(other))?.under === one)) add(next);
    };
    add(bottom);
    // A shown member whose lower neighbour is hidden by a filter still belongs here.
    for (const other of pulls) {
      if (!done.has(other) && sameStack(other, bottom, places)) add(other);
    }
    groups.push(stack.length === 1 ? { pull: stack[0] as PullRequest } : { stack, into: place.into });
  }
  return groups;
}

function sameStack(a: PullRequest, b: PullRequest, places: Map<string, StackPlace>): boolean {
  const root = (pull: PullRequest) => {
    let at = pull;
    for (let under = places.get(keyOf(at))?.under; under; under = places.get(keyOf(under))?.under) at = under;
    return at;
  };
  return places.has(keyOf(a)) && root(a) === root(b);
}
