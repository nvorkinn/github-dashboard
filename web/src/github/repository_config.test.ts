import { expect, test } from "vitest";
import { fakeDashboard } from "../components/testing.ts";
import {
  type ClassicRule,
  compareRules,
  createRepositoryConfig,
  REPOSITORY_SETTINGS,
  type Repository,
  type RuleSnapshot,
  type Ruleset,
} from "./repository_config.ts";
import { fakeGitHub, type Routes } from "./testing.ts";

const SOURCE = "octo/source";
const TARGET = "octo/target";
const repository = (name: string, more = {}): Repository => ({
  full_name: name,
  node_id: `repo:${name}`,
  default_branch: "main",
  permissions: { admin: true },
  delete_branch_on_merge: false,
  allow_auto_merge: false,
  allow_merge_commit: true,
  allow_squash_merge: true,
  allow_rebase_merge: false,
  ...more,
});
const empty = () => ({ nodes: [], pageInfo: { hasNextPage: false, endCursor: null } });
function classic(id = "BP1", pattern = "main", more = {}): ClassicRule {
  return {
    id,
    pattern,
    allowsDeletions: false,
    allowsForcePushes: false,
    blocksCreations: false,
    dismissesStaleReviews: false,
    isAdminEnforced: true,
    lockAllowsFetchAndMerge: false,
    lockBranch: false,
    requireLastPushApproval: false,
    requiredApprovingReviewCount: 1,
    requiresApprovingReviews: true,
    requiresCodeOwnerReviews: false,
    requiresCommitSignatures: false,
    requiresConversationResolution: true,
    requiresDeployments: false,
    requiresLinearHistory: false,
    requiresStatusChecks: false,
    requiresStrictStatusChecks: false,
    restrictsPushes: false,
    restrictsReviewDismissals: false,
    requiredStatusChecks: [],
    requiredDeploymentEnvironments: [],
    bypassForcePushAllowances: empty(),
    bypassPullRequestAllowances: empty(),
    pushAllowances: empty(),
    reviewDismissalAllowances: empty(),
    ...more,
  };
}
const ruleset = (id: number, name = `Rule ${id}`, more = {}): Ruleset => ({
  id,
  name,
  target: "branch",
  source: SOURCE,
  source_type: "Repository",
  enforcement: "active",
  conditions: { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } },
  bypass_actors: [],
  rules: [{ type: "deletion" }],
  ...more,
});
const snap = (classic: ClassicRule[] = [], rulesets: Ruleset[] = []): RuleSnapshot => ({
  classic,
  rulesets,
  problems: [],
});
function setup(from = snap(), to = snap(), more: Routes = {}) {
  const routes: Routes = {
    [`repos/${SOURCE}`]: repository(SOURCE),
    [`repos/${TARGET}`]: repository(TARGET),
    [`repos/${SOURCE}/rulesets`]: from.rulesets,
    [`repos/${TARGET}/rulesets`]: to.rulesets,
    [`repos/${TARGET}/commits/main/check-runs`]: { check_runs: [] },
    [`repos/${TARGET}/commits/main/statuses`]: [],
    ...more,
  };
  for (const rule of from.rulesets) routes[`repos/${SOURCE}/rulesets/${rule.id}`] = rule;
  for (const rule of to.rulesets) routes[`repos/${TARGET}/rulesets/${rule.id}`] = rule;
  const github = fakeGitHub(routes);
  const original = github.auth.github;
  github.auth.github = async (path, init) => {
    if (path !== "graphql" || more["POST graphql"]) return original(path, init);
    const body = JSON.parse(String(init?.body)) as { query: string; variables: { name: string } };
    github.requests.push({ method: "POST", path, body });
    github.calls.push(path);
    if (body.query.startsWith("mutation"))
      return Response.json({
        data: {
          [body.query.includes("createBranchProtectionRule")
            ? "createBranchProtectionRule"
            : "updateBranchProtectionRule"]: { branchProtectionRule: { id: "new" } },
        },
      });
    return Response.json({
      data: {
        repository: {
          branchProtectionRules: { ...empty(), nodes: body.variables.name === "source" ? from.classic : to.classic },
        },
      },
    });
  };
  const dashboard = fakeDashboard();
  return { ...github, routes, dashboard, config: createRepositoryConfig(github.auth, dashboard) };
}
const mutations = (requests: { method: string; path: string; body: unknown }[]) =>
  requests.filter(
    (r) => r.method !== "GET" && (r.path !== "graphql" || (r.body as { query: string }).query.startsWith("mutation")),
  );

test("each repository toggle sends only the requested field and refreshes dashboard state", async () => {
  for (const setting of Object.keys(REPOSITORY_SETTINGS) as (keyof typeof REPOSITORY_SETTINGS)[]) {
    const value = repository(TARGET)[setting] === true;
    const { config, requests, dashboard } = setup(snap(), snap(), { [`PATCH repos/${TARGET}`]: {} });
    await config.save(TARGET, setting, !value, value);
    expect(mutations(requests)).toEqual([{ method: "PATCH", path: `repos/${TARGET}`, body: { [setting]: !value } }]);
    expect(dashboard.refresh).toHaveBeenCalledOnce();
  }
});

test("settings enforce admin, archived, disclosed values, stale state and the last merge method", async () => {
  for (const more of [
    { permissions: { admin: false } },
    { archived: true },
    { allow_auto_merge: true },
    { allow_auto_merge: undefined },
  ]) {
    const { config, requests } = setup(snap(), snap(), { [`repos/${TARGET}`]: repository(TARGET, more) });
    await expect(config.save(TARGET, "allow_auto_merge", true, false)).rejects.toThrow();
    expect(mutations(requests)).toEqual([]);
  }
  const { config, requests } = setup(snap(), snap(), {
    [`repos/${TARGET}`]: repository(TARGET, { allow_squash_merge: false }),
  });
  await expect(config.save(TARGET, "allow_merge_commit", false, true)).rejects.toThrow("at least one");
  expect(mutations(requests)).toEqual([]);
});

test("API refusals and uncertain writes are surfaced without retrying; dashboard refreshes", async () => {
  for (const status of [401, 403, 404, 422, 429, 500]) {
    const { config, requests, dashboard } = setup(snap(), snap(), {
      [`PATCH repos/${TARGET}`]: () => Response.json({ message: "Denied" }, { status }),
    });
    await expect(config.save(TARGET, "allow_auto_merge", true, false)).rejects.toThrow();
    expect(mutations(requests)).toHaveLength(1);
    expect(dashboard.refresh).toHaveBeenCalledOnce();
  }
});

test("repository list uses all installations, paginates, deduplicates, and sorts accessible repositories", async () => {
  const { config } = setup(snap(), snap(), {
    "user/installations": { installations: [{ id: 1 }, { id: 2 }] },
    "user/installations/1/repositories": { repositories: [repository(TARGET), repository(SOURCE)] },
    "user/installations/2/repositories": { repositories: [repository(SOURCE)] },
  });
  expect((await config.repositories()).map((r) => r.full_name)).toEqual([SOURCE, TARGET]);
});

test("compares exact identities; maps only exact default names and preserves wildcard, symbolic, and target-only rules", () => {
  const changes = compareRules(
    repository(SOURCE),
    repository(TARGET, { default_branch: "trunk" }),
    snap(
      [classic(), classic("BP2", "release/*")],
      [
        ruleset(1, "Branches", {
          conditions: {
            ref_name: {
              include: ["refs/heads/main", "refs/heads/release/*", "~DEFAULT_BRANCH"],
              exclude: ["refs/heads/main"],
            },
          },
        }),
      ],
    ),
    snap([classic("old", "trunk", { isAdminEnforced: false }), classic("keep", "production")]),
    true,
  );
  expect(changes.map((c) => c.action)).toEqual(["Replace", "Add", "Add", "Unchanged"]);
  expect(changes[0]?.targetId).toBe("old");
  expect(changes[1]?.after.pattern).toBe("release/*");
  expect(changes[2]?.after.conditions).toEqual({
    ref_name: {
      include: ["refs/heads/trunk", "refs/heads/release/*", "~DEFAULT_BRANCH"],
      exclude: ["refs/heads/trunk"],
    },
  });
  expect(
    compareRules(repository(SOURCE), repository(TARGET), snap([classic()]), snap([classic("old")]), false)[0]?.action,
  ).toBe("Unchanged");
});

test("preview never mutates and requires exact app evidence for required checks", async () => {
  const from = snap([
    classic("BP1", "main", {
      requiresStatusChecks: true,
      requiredStatusChecks: [{ context: "CI", app: { id: "APP1", databaseId: 1 } }],
    }),
  ]);
  const { config, requests, routes } = setup(from);
  const blocked = await config.preview(SOURCE, TARGET, false);
  expect(blocked.changes[0]?.problems.join(" ")).toContain("CI");
  routes[`repos/${TARGET}/commits/main/check-runs`] = { check_runs: [{ name: "CI", app: { id: 1, node_id: "APP1" } }] };
  const safe = await config.preview(SOURCE, TARGET, false);
  expect(safe.changes[0]?.problems).toEqual([]);
  expect(safe.changes[0]?.after.requiredStatusChecks).toEqual([{ context: "CI", appId: "APP1" }]);
  expect(mutations(requests)).toEqual([]);
});

test("unverified bypass actors, unsupported fields, inherited rules and incomplete actor pages block affected changes", async () => {
  const from = snap(
    [
      classic("BP1", "main", {
        bypassPullRequestAllowances: {
          ...empty(),
          pageInfo: { hasNextPage: true, endCursor: "more" },
          nodes: [{ actor: { __typename: "Team", id: "TEAM1", slug: "owners" } }],
        },
      }),
    ],
    [
      ruleset(1, "Actors", { bypass_actors: [{ actor_id: 99, actor_type: "Integration", bypass_mode: "always" }] }),
      ruleset(2, "Unsupported", { rules: [{ type: "workflows", parameters: { workflows: [{ repository_id: 99 }] } }] }),
      ruleset(3, "Inherited", { source_type: "Organization", source: "octo" }),
    ],
  );
  const { config } = setup(from);
  const preview = await config.preview(SOURCE, TARGET, false);
  expect(preview.changes.every((change) => change.problems.length > 0)).toBe(true);
  await expect(config.apply(preview, ["classic:BP1"])).rejects.toThrow("supported");
});

test("verified target team identities can be copied; no slug remapping across organizations", async () => {
  const { config } = setup(
    snap(
      [
        classic("BP1", "main", {
          pushAllowances: { ...empty(), nodes: [{ actor: { __typename: "Team", id: "TEAM1", slug: "owners" } }] },
        }),
      ],
      [ruleset(1, "Actors", { bypass_actors: [{ actor_id: 5, actor_type: "Team", bypass_mode: "always" }] })],
    ),
    snap(),
    {
      [`repos/${TARGET}/teams`]: [{ id: 5, node_id: "TEAM1" }],
      [`repos/${TARGET}/collaborators`]: [],
    },
  );
  const preview = await config.preview(SOURCE, TARGET, false);
  expect(preview.changes.every((change) => change.problems.length === 0)).toBe(true);
  expect(preview.changes[0]?.after.pushActorIds).toEqual(["TEAM1"]);
});

test("stale and tampered previews fail before a write", async () => {
  const { config, routes, requests } = setup(snap([classic()]));
  const plan = await config.preview(SOURCE, TARGET, false);
  routes[`repos/${TARGET}`] = repository(TARGET, { default_branch: "trunk" });
  await expect(config.apply(plan, ["classic:BP1"])).rejects.toThrow("changed");
  plan.target = SOURCE;
  await expect(config.apply(plan, ["classic:BP1"])).rejects.toThrow("invalid");
  expect(mutations(requests)).toEqual([]);
});

test("partial outcomes stop at failure, preserve successful changes, and consume the preview", async () => {
  const from = snap([], [ruleset(1), ruleset(2), ruleset(3)]);
  let writes = 0;
  const { config, requests, dashboard } = setup(from, snap(), {
    [`POST repos/${TARGET}/rulesets`]: () =>
      ++writes === 1 ? Response.json({ id: 10 }) : Response.json({ message: "Permission denied" }, { status: 403 }),
  });
  const plan = await config.preview(SOURCE, TARGET, false);
  const result = await config.apply(plan, ["ruleset:1", "ruleset:2", "ruleset:3"]);
  expect(result.map((r) => r.status)).toEqual(["applied", "failed", "skipped"]);
  expect(mutations(requests)).toHaveLength(2);
  expect(dashboard.refresh).toHaveBeenCalledOnce();
  await expect(config.apply(plan, ["ruleset:1"])).rejects.toThrow("invalid");
});

test("classic create/update use target repository ID or target rule ID, never the source rule ID", async () => {
  for (const target of [snap(), snap([classic("TARGET_BP", "main", { isAdminEnforced: false })])]) {
    const { config, requests } = setup(snap([classic()]), target);
    const plan = await config.preview(SOURCE, TARGET, false);
    expect((await config.apply(plan, ["classic:BP1"]))[0]?.status).toBe("applied");
    const write = mutations(requests)[0]?.body as { query: string; variables: { input: Record<string, unknown> } };
    expect(write.variables.input).toMatchObject(
      target.classic.length ? { branchProtectionRuleId: "TARGET_BP" } : { repositoryId: `repo:${TARGET}` },
    );
    expect(write.query).toContain(target.classic.length ? "updateBranchProtectionRule" : "createBranchProtectionRule");
  }
});

test("partial read failure disables application while retaining available preview data", async () => {
  const { config } = setup(snap([], [ruleset(1)]), snap(), {
    "POST graphql": () => Response.json({ errors: [{ message: "Not allowed" }] }),
  });
  const plan = await config.preview(SOURCE, TARGET, false);
  expect(plan.changes).toHaveLength(1);
  expect(plan.problems.join(" ")).toContain("Not allowed");
  await expect(config.apply(plan, ["ruleset:1"])).rejects.toThrow("Not allowed");
});

test("same-name tag and inherited target rulesets are preserved, never replaced by branch rules", () => {
  const changes = compareRules(
    repository(SOURCE),
    repository(TARGET),
    snap([], [ruleset(1, "Rules")]),
    snap(
      [],
      [
        ruleset(10, "Rules", { target: "tag", source: TARGET }),
        ruleset(11, "Rules", { source_type: "Organization", source: "octo" }),
      ],
    ),
    false,
  );
  expect(changes.map((c) => c.action)).toEqual(["Add", "Unchanged", "Unchanged"]);
  expect(changes[0]?.targetId).toBeUndefined();
});

test("default mapping collisions and unsupported nested status check fields block copying", () => {
  const changes = compareRules(
    repository(SOURCE),
    repository(TARGET, { default_branch: "trunk" }),
    snap(
      [classic("a", "main"), classic("b", "trunk")],
      [
        ruleset(1, "Unknown check", {
          rules: [
            {
              type: "required_status_checks",
              parameters: { required_status_checks: [{ context: "CI", future_field: true }] },
            },
          ],
        }),
      ],
    ),
    snap(),
    true,
  );
  expect(changes.every((c) => c.problems.length > 0)).toBe(true);
});

test("classic protections read every page including rules not matching any existing branch", async () => {
  const { config, auth } = setup();
  const original = auth.github;
  auth.github = async (path, init) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (path !== "graphql" || body?.variables?.name !== "source") return original(path, init);
    return Response.json({
      data: {
        repository: {
          branchProtectionRules: {
            nodes: [classic(body.variables.after ? "last" : "first", body.variables.after ? "future/*" : "main")],
            pageInfo: { hasNextPage: !body.variables.after, endCursor: body.variables.after ? null : "next" },
          },
        },
      },
    });
  };
  const preview = await config.preview(SOURCE, TARGET, false);
  expect(preview.changes.map((c) => c.after.pattern)).toEqual(["main", "future/*"]);
});

test("ruleset replacement uses the target ID and does not delete unrelated rules", async () => {
  const { config, requests } = setup(
    snap([], [ruleset(1, "Policy")]),
    snap(
      [],
      [ruleset(50, "Policy", { source: TARGET, enforcement: "disabled" }), ruleset(60, "Keep", { source: TARGET })],
    ),
    {
      [`PUT repos/${TARGET}/rulesets/50`]: {},
    },
  );
  const plan = await config.preview(SOURCE, TARGET, false);
  expect(plan.changes.map((c) => c.action)).toEqual(["Replace", "Unchanged"]);
  expect((await config.apply(plan, ["ruleset:1"]))[0]?.status).toBe("applied");
  expect(mutations(requests)).toEqual([
    {
      method: "PUT",
      path: `repos/${TARGET}/rulesets/50`,
      body: expect.objectContaining({ name: "Policy", enforcement: "active" }),
    },
  ]);
});

test("network failures never retry creation and the consumed plan cannot be reused", async () => {
  const { config, requests } = setup(snap([], [ruleset(1)]), snap(), {
    [`POST repos/${TARGET}/rulesets`]: () => {
      throw new TypeError("Network failed");
    },
  });
  const plan = await config.preview(SOURCE, TARGET, false);
  const results = await config.apply(plan, ["ruleset:1"]);
  expect(results[0]?.status).toBe("failed");
  expect(results[0]?.message).toContain("may have gone through");
  await expect(config.apply(plan, ["ruleset:1"])).rejects.toThrow("invalid");
  expect(mutations(requests)).toHaveLength(1);
});

test("another administrator changing a later target rule during copying stops its replacement", async () => {
  const targetRules = snap([], [ruleset(50, "Policy", { source: TARGET, enforcement: "disabled" })]);
  const { config, requests, routes } = setup(snap([], [ruleset(1, "New"), ruleset(2, "Policy")]), targetRules, {
    [`POST repos/${TARGET}/rulesets`]: () => {
      routes[`repos/${TARGET}/rulesets/50`] = ruleset(50, "Policy", { source: TARGET, enforcement: "evaluate" });
      return Response.json({ id: 90 });
    },
  });
  const plan = await config.preview(SOURCE, TARGET, false);
  const results = await config.apply(plan, ["ruleset:1", "ruleset:2"]);
  expect(results.map((r) => r.status)).toEqual(["applied", "failed"]);
  expect(results[1]?.message).toContain("changed during copying");
  expect(mutations(requests)).toHaveLength(1);
});
