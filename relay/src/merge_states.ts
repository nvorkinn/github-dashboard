import { type MergeUpdate, mergeStateOf } from "../../shared/pulls.ts";
import { type GitHubApp, reasonOf } from "./github_app.ts";
import { commit, record, text, wholeNumber } from "./payload.ts";
import { withPurpose } from "./telemetry.ts";

/**
 * How long after each try the pull requests still `unknown` are asked about again: GitHub works mergeability out in
 * the background, and only once asked. With the first, that is five tries; what is still unknown after the last
 * stays so on the page until the next push or the page's own slow read of everything.
 */
export const RETRY_MS = [2000, 4000, 8000, 16_000] as const;
// No more open pull requests into one branch than this many pages of 100 are asked about.
const MAX_PAGES = 5;

// Each asks for its own cost too, for the relay's telemetry (see github_app.ts), which takes it out of the answer.
const OPEN_PULLS = `query($owner: String!, $name: String!, $base: String!, $after: String) {
  rateLimit { cost remaining }
  repository(owner: $owner, name: $name) {
    pullRequests(states: OPEN, baseRefName: $base, first: 100, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes { number state baseRefName headRefOid mergeable mergeStateStatus }
    }
  }
}`;

/** The query of these pull requests of one repository, by number: `p<number>` each. */
function byNumber(numbers: number[]): string {
  const fields = numbers.map((number) => `p${number}: pullRequest(number: ${number}) { ...M }`);
  return `query($owner: String!, $name: String!) {
  rateLimit { cost remaining }
  repository(owner: $owner, name: $name) {
    ${fields.join("\n    ")}
  }
}
fragment M on PullRequest { number state baseRefName headRefOid mergeable mergeStateStatus }`;
}

type Told = MergeUpdate["pulls"][number];

/**
 * Whether the open pull requests into a branch can still be merged, worked out after each push to that branch and told
 * to the open pages. GitHub sends no webhook when a push to its base makes a pull request conflict or fall behind, so
 * the push is the only sign: the relay asks GitHub as the app, and the pages don't each read every pull request again.
 *
 * Per repository and branch one loop runs at a time: a push while one is going ends it and starts over. Nothing is
 * asked while no page is open, which reads everything when it opens anyway.
 */
export type MergeStates = {
  /** Takes in a webhook; only a push to a branch does anything. */
  onWebhook(kind: string, payload: Record<string, unknown>): void;
};

export function createMergeStates(options: {
  app: GitHubApp;
  /** Some pull requests' merge states, for the pages. */
  onUpdate(update: MergeUpdate): void;
  /** Whether a page is open to be told. */
  listening(): boolean;
  /** Ends every loop when it fires. */
  closing?: AbortSignal | undefined;
}): MergeStates {
  const { app } = options;
  type Loop = { cancelled: boolean; timer?: ReturnType<typeof setTimeout>; wake?: () => void };
  const loops = new Map<string, Loop>();

  function cancel(loop: Loop): void {
    loop.cancelled = true;
    clearTimeout(loop.timer);
    loop.wake?.();
  }

  options.closing?.addEventListener("abort", () => {
    for (const loop of loops.values()) {
      cancel(loop);
    }
    loops.clear();
  });

  /** Waits `ms`, or less if the loop is cancelled meanwhile. */
  function wait(loop: Loop, ms: number): Promise<void> {
    return new Promise((resolve) => {
      loop.wake = resolve;
      loop.timer = setTimeout(resolve, ms);
    });
  }

  /** The pull requests in an answer that are open and still into `base`, in the page's words. */
  function pullsOf(nodes: unknown[], base: string): Told[] {
    const found: Told[] = [];
    for (const node of nodes) {
      const one = record(node);
      const number = wholeNumber(one.number);
      const sha = commit(one.headRefOid);
      if (number === undefined || sha === undefined || one.state !== "OPEN" || one.baseRefName !== base) {
        continue;
      }
      found.push({
        number,
        sha,
        mergeState: mergeStateOf(text(one.mergeable) ?? "", text(one.mergeStateStatus) ?? ""),
      });
    }
    return found;
  }

  async function openPulls(installation: number, owner: string, name: string, base: string): Promise<Told[]> {
    const found: Told[] = [];
    let after: string | null = null;
    for (let page = 0; page < MAX_PAGES; page++) {
      const { data } = await app.query(installation, OPEN_PULLS, { owner, name, base, after });
      const list = record(record(data.repository).pullRequests);
      found.push(...pullsOf(Array.isArray(list.nodes) ? list.nodes : [], base));
      const info = record(list.pageInfo);
      after = info.hasNextPage === true ? (text(info.endCursor) ?? null) : null;
      if (after === null) {
        break;
      }
    }
    return found;
  }

  async function somePulls(
    installation: number,
    owner: string,
    name: string,
    base: string,
    numbers: number[],
  ): Promise<Told[]> {
    // A pull request that is gone is a field GitHub answers with null and an error; the others still come.
    const { data } = await app.query(installation, byNumber(numbers), { owner, name });
    const repository = record(data.repository);
    return pullsOf(
      numbers.map((number) => repository[`p${number}`]),
      base,
    );
  }

  async function run(loop: Loop, installation: number, repo: string, base: string): Promise<void> {
    const [owner = "", name = ""] = repo.split("/");
    const tell = (pulls: Told[]) => {
      if (!loop.cancelled && pulls.length > 0) {
        options.onUpdate({ repo, base, pulls });
      }
    };
    const unknown = (pulls: Told[]) => pulls.filter((one) => one.mergeState === "unknown").map((one) => one.number);

    const first = await openPulls(installation, owner, name, base);
    // Unknown ones too: what the page showed is from before the push.
    tell(first);
    let waiting = unknown(first);
    for (const ms of RETRY_MS) {
      if (waiting.length === 0) {
        return;
      }
      await wait(loop, ms);
      if (loop.cancelled || !options.listening()) {
        return;
      }
      const again = await somePulls(installation, owner, name, base, waiting);
      tell(again.filter((one) => one.mergeState !== "unknown"));
      waiting = unknown(again);
    }
  }

  return {
    onWebhook(kind, payload) {
      if (kind !== "push" || payload.deleted === true || !options.listening() || options.closing?.aborted) {
        return;
      }
      const ref = text(payload.ref);
      const repo = text(record(payload.repository).full_name);
      const installation = wholeNumber(record(payload.installation).id);
      if (!ref?.startsWith("refs/heads/") || repo === undefined || installation === undefined) {
        return;
      }
      const base = ref.slice("refs/heads/".length);
      const key = `${repo}\n${base}`;
      const before = loops.get(key);
      if (before) {
        cancel(before);
      }
      const loop: Loop = { cancelled: false };
      loops.set(key, loop);
      void withPurpose("merge_states.push", () => run(loop, installation, repo, base))
        .catch((error: unknown) => {
          if (!loop.cancelled) {
            console.warn(`merge states of ${repo} not read: ${reasonOf(error)}`);
          }
        })
        .finally(() => {
          if (loops.get(key) === loop) {
            loops.delete(key);
          }
        });
    },
  };
}
