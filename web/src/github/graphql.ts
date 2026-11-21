/**
 * Reads what the dashboard shows of GitHub through its GraphQL API, in a handful of requests sent side by side where
 * the REST API takes a dozen per project. What comes back is put into the shapes of the REST answers and then into the
 * model by the same code as a read of changes (read.ts), so the two can't differ in what they make of GitHub's words.
 *
 * A read asks for:
 *
 * - every repository the signed-in user reaches through the app: what a project's row shows, nothing more;
 * - of each project that isn't hidden: its open pull requests with their checks, and what its default branch has
 *   that its latest release hasn't;
 * - of each hidden project: its open pull requests, bare (number, title, link). They go with the first page of the
 *   list, whose rate-limit cost they don't raise: GitHub charges a hundred lists as one point.
 *
 * Release runs aren't read here: the relay keeps them and tells the page (see dashboard.ts).
 *
 * The projects are asked about by name, so a read has to know them before it asks: that is the `Shape`, which a read
 * gives back for the next one. A read that finds it wrong (no shape yet, a new project) asks again for what is
 * missing, so only such a read takes more than one round of requests.
 */
import type { Auth } from "../auth.ts";
import type { BarePull, DashboardData, PullRequest, Unreleased } from "../model.ts";
import { createApi, GitHubError, limiter, MAX_PARALLEL, type QueryAnswer, sendQuery } from "./api.ts";
import {
  type GqlPull,
  latestOf,
  of,
  PULL,
  problemOf,
  project,
  pullFrom,
  pullRequests,
  pullRequestWithAllChecks,
  type RawRepo,
  type ReadResult,
  refused,
  settingsOf,
} from "./read.ts";
import { comparisonField, type GqlComparison, unreleasedFrom } from "./unreleased.ts";

// How much one request asks for. GitHub refuses a query that could name more than 500,000 things, and charges the
// rate limit by how many lists it reads, so these are no larger than they need to be. What doesn't fit is read
// the way a read of changes reads it.
export const REPOS_PER_PAGE = 100;
export const PULLS_PER_REPO = 50;
// How many of a hidden project's pull requests are read: the newest, as nothing more of them is shown.
export const BARE_PULLS_PER_REPO = 50;
// How many projects one request asks about. GitHub answers a query's fields one after another, each project taking
// about a tenth of a second, so a read sends its requests side by side: a few in each is several times faster than
// all in one.
export const REPOS_PER_REQUEST = 7;
// A read never needs this many rounds of requests; one that would has gone wrong, and stops.
const MAX_ROUNDS = 10;

/**
 * The projects (`owner/name`) a read asks about. Only names, so it can be kept in the browser between visits.
 */
export type Shape = string[];

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

export type EverythingResult = ReadResult & { shape: Shape };

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
  defaultBranchRef: { name: string } | null;
};
type GqlDetails = {
  pullRequests: { pageInfo: { hasNextPage: boolean }; nodes: (GqlPull | null)[] };
};
type GqlBare = { pullRequests: { nodes: (BarePull | null)[] } };

const LISTED = `fragment Listed on Repository {
  nameWithOwner name url isPrivate pushedAt
  mergeCommitAllowed squashMergeAllowed rebaseMergeAllowed autoMergeAllowed
  latestRelease { tagName url publishedAt createdAt }
  defaultBranchRef { name }
}`;

const PULLS = `fragment Pulls on Repository {
  pullRequests(first: ${PULLS_PER_REPO}, states: OPEN, orderBy: {field: CREATED_AT, direction: DESC}) {
    pageInfo { hasNextPage }
    nodes { ...Pull }
  }
}`;

/** What a project's default branch has that its latest release hasn't. */
type CompareAsk = { repo: string; tag: string; branch: string };

/** What one request asks for. */
export type Asked = {
  list: { after: string | undefined } | undefined;
  repos: string[];
  compares: CompareAsk[];
  /** The hidden projects whose bare pull requests are asked for. */
  bare?: string[] | undefined;
};

/** A string as GraphQL writes one, which is as JSON does. */
function quoted(text: string): string {
  return JSON.stringify(text);
}

function repository(repo: string): string {
  const [owner = "", name = ""] = repo.split("/");
  return `repository(owner: ${quoted(owner)}, name: ${quoted(name)})`;
}

/**
 * The query for `asked`. Each project is the field `r<n>`, each comparison `c<n>` and each hidden project `h<n>`,
 * numbered as they are in `asked`.
 */
export function queryFor(asked: Asked): string {
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
    fields.push(`r${index}: ${repository(repo)} { ...Pulls }`);
  });
  asked.compares.forEach(({ repo, tag, branch }, index) => {
    fields.push(`c${index}: ${comparisonField(repo, tag, branch)}`);
  });
  (asked.bare ?? []).forEach((repo, index) => {
    fields.push(
      `h${index}: ${repository(repo)} { pullRequests(first: ${BARE_PULLS_PER_REPO}, states: OPEN, orderBy: {field: CREATED_AT, direction: DESC}) { nodes { number title url } } }`,
    );
  });
  const fragments = [...(asked.list ? [LISTED] : []), ...(asked.repos.length > 0 ? [PULLS, PULL] : [])];
  return [`query {\n  ${fields.join("\n  ")}\n}`, ...fragments].join("\n");
}

/** `asked` as the requests to send side by side: the list (with the hidden projects), then a few projects in each. */
export function split(asked: Asked): Asked[] {
  const nothing: Asked = { list: undefined, repos: [], compares: [] };
  const chunks = <T>(all: T[], size: number): T[][] =>
    Array.from({ length: Math.ceil(all.length / size) }, (_, index) => all.slice(index * size, (index + 1) * size));
  return [
    ...(asked.list ? [{ ...nothing, list: asked.list, ...(asked.bare?.length ? { bare: asked.bare } : {}) }] : []),
    ...chunks(asked.repos, REPOS_PER_REQUEST).map((repos) => ({ ...nothing, repos })),
    ...chunks(asked.compares, REPOS_PER_REQUEST).map((compares) => ({ ...nothing, compares })),
  ];
}

/**
 * Reads everything the dashboard shows of GitHub. A project whose pull requests can't be read doesn't take the
 * others down: that part stays as it was in `previous` (or empty on a first read) and `problem` says so. A rate
 * limit, a sign-in GitHub no longer accepts or a failing network is thrown instead, as every other call would fail
 * the same way.
 *
 * Of a hidden project only its row and its bare pull requests (`barePulls`) are read: it has no pull requests here.
 * Its bare ones that GitHub wouldn't say stay as they were in `previous`. The release runs and each project's
 * Promote workflow stay as they are in `previous`: they are the relay's to say.
 */
export async function readEverything(auth: Auth, options: EverythingOptions = {}): Promise<EverythingResult> {
  const { previous, signal } = options;
  const hidden = options.hidden ?? new Set<string>();
  const shape = options.shape ?? [];

  const listed = new Map<string, GqlRepo>();
  let list: Asked["list"] = { after: undefined };
  const details = new Map<string, GqlDetails | undefined>();
  const bare = new Map<string, BarePull[]>();
  // The projects GitHub wouldn't say everything of.
  const troubled = new Set<string>();

  const repoQueue = queue<string>((repo) => repo);
  // What is unreleased can only be asked for by the release's tag, which the list of projects says. To save a
  // round of requests it is asked for by the tag of the last read, and again only if the list says another.
  const compareQueue = queue<CompareAsk>(compareKey);
  const comparisons = new Map<string, Unreleased | undefined>();
  for (const repo of shape) {
    if (!hidden.has(repo)) {
      repoQueue.add(repo);
      const before = previous?.projects.find(of(repo));
      if (before?.latestRelease && before.defaultBranch !== undefined) {
        compareQueue.add({ repo, tag: before.latestRelease.tag, branch: before.defaultBranch });
      }
    }
  }

  const limit = limiter(options.parallel ?? MAX_PARALLEL);

  /** Takes in the answer to one request. */
  function absorb(asked: Asked, { data, errors }: QueryAnswer): void {
    // What GitHub wouldn't say, by the field it is under.
    const refusedFields = new Set<string>();
    for (const error of errors) {
      const field = error?.path?.[0];
      if (typeof field !== "string" || field === "viewer") {
        throw new GitHubError("graphql", 502, undefined);
      }
      refusedFields.add(field);
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
    });
    asked.compares.forEach((compare, index) => {
      if (refusedFields.has(`c${index}`)) {
        troubled.add(compare.repo);
      } else {
        comparisons.set(compareKey(compare), unreleasedFrom(data[`c${index}`] as GqlComparison, compare.branch));
      }
    });
    (asked.bare ?? []).forEach((repo, index) => {
      const nodes = (data[`h${index}`] as GqlBare | null | undefined)?.pullRequests?.nodes;
      if (!refusedFields.has(`h${index}`) && Array.isArray(nodes)) {
        bare.set(
          repo,
          nodes.filter((pull) => pull !== null).map(({ number, title, url }) => ({ number, title, url })),
        );
      }
    });
  }

  // Asked once, with the list's first page; of a project the last read didn't list, which may be gone, only on a read
  // that knows none.
  let bareAsk: string[] | undefined = [...hidden].filter((repo) => shape.length === 0 || shape.includes(repo)).sort();
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const requests = split({ list, repos: repoQueue.take(), compares: compareQueue.take(), bare: bareAsk });
    bareAsk = undefined;
    if (requests.length === 0) {
      break;
    }
    const answers = await Promise.all(requests.map((asked) => limit(() => sendQuery(auth, queryFor(asked), signal))));
    requests.forEach((asked, index) => {
      absorb(asked, answers[index] as QueryAnswer);
    });

    // What this answer shows to be missing still.
    if (!list) {
      for (const [repo, one] of listed) {
        if (!hidden.has(repo)) {
          repoQueue.add(repo);
          if (one.latestRelease && one.defaultBranchRef) {
            compareQueue.add({ repo, tag: one.latestRelease.tagName, branch: one.defaultBranchRef.name });
          }
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
      const before = previous?.projects.find(of(repo));
      if (hidden.has(repo)) {
        const barePulls = bare.get(repo) ?? before?.barePulls;
        return {
          project: { ...project(raw, latestRelease, settingsOf(raw), before?.promoteWorkflow), barePulls },
          pulls: [],
        };
      }
      if (troubled.has(repo)) {
        failed.add(repo);
      }
      const was = previous?.pulls.filter(of(repo)) ?? [];
      // What couldn't be read is kept only while it is the same release.
      const unreleased =
        (latestRelease && raw.default_branch !== undefined
          ? comparisons.get(compareKey({ repo, tag: latestRelease.tag, branch: raw.default_branch }))
          : undefined) ?? (before?.latestRelease?.tag === latestRelease?.tag ? before?.unreleased : undefined);
      const answer = details.get(repo);
      let pulls = was;
      if (!answer) {
        // Not answered, or never asked because the read stopped short.
        failed.add(repo);
      } else {
        try {
          pulls = await pullsOf(api, repo, answer);
        } catch (error) {
          // A part read through the REST API, where GitHub refusing it leaves the part as it was.
          if (!refused(error)) {
            throw error;
          }
          failed.add(repo);
        }
      }
      return { project: project(raw, latestRelease, settingsOf(raw), before?.promoteWorkflow, unreleased), pulls };
    }),
  );
  return {
    data: {
      projects: read.map((one) => one.project),
      pulls: read.flatMap((one) => one.pulls),
      releases: previous?.releases ?? [],
    },
    problem: problemOf(failed),
    shape: repos.map((one) => one.nameWithOwner),
  };
}

type Page<T> = { pageInfo?: { hasNextPage?: boolean; endCursor?: string | null }; nodes?: (T | null)[] };

const compareKey = (compare: CompareAsk) => `${compare.repo}\n${compare.tag}\n${compare.branch}`;

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

function rawRepo(repo: GqlRepo): RawRepo {
  return {
    full_name: repo.nameWithOwner,
    name: repo.name,
    html_url: repo.url,
    private: repo.isPrivate,
    archived: false,
    pushed_at: repo.pushedAt,
    ...(repo.defaultBranchRef ? { default_branch: repo.defaultBranchRef.name } : {}),
    allow_merge_commit: repo.mergeCommitAllowed,
    allow_squash_merge: repo.squashMergeAllowed,
    allow_rebase_merge: repo.rebaseMergeAllowed,
    allow_auto_merge: repo.autoMergeAllowed,
  };
}

/**
 * The project's open pull requests. More than fit into the answer are read the way a read of changes reads them, and
 * a pull request with more checks than fit through the REST API.
 */
async function pullsOf(api: ReturnType<typeof createApi>, repo: string, answer: GqlDetails): Promise<PullRequest[]> {
  if (answer.pullRequests.pageInfo.hasNextPage) {
    return pullRequests(api, repo);
  }
  const pulls = await Promise.all(
    answer.pullRequests.nodes
      .filter((pull) => pull !== null)
      .map((pull) =>
        pull.statusCheckRollup?.contexts.pageInfo.hasNextPage
          ? pullRequestWithAllChecks(api, repo, pull.number)
          : pullFrom(repo, pull),
      ),
  );
  return pulls.filter((pull) => pull !== undefined);
}
