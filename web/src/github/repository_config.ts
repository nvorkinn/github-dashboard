import type { Auth } from "../auth.ts";
import type { Dashboard } from "../model.ts";
import { type Api, createApi, GitHubError, retryAt } from "./api.ts";
import { ActionError, describeAction, send, worded } from "./writes.ts";

export const REPOSITORY_SETTINGS = {
  delete_branch_on_merge: "Delete branches after merging",
  allow_auto_merge: "Allow auto-merge",
  allow_merge_commit: "Allow merge commits",
  allow_squash_merge: "Allow squash merging",
  allow_rebase_merge: "Allow rebase merging",
} as const;
export type Setting = keyof typeof REPOSITORY_SETTINGS;
export type Repository = Partial<Record<Setting, boolean>> & {
  full_name: string;
  node_id: string;
  default_branch: string;
  archived?: boolean;
  permissions?: { admin?: boolean };
};
type Json = Record<string, unknown>;
type Page<T> = { nodes: T[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } };
type Actor = { __typename: string; id: string; login?: string; slug?: string };
type Allowances = Page<{ actor: Actor | null }>;
export type ClassicRule = Json & {
  id: string;
  pattern: string;
  requiredStatusChecks: { context: string; app: { id: string; databaseId: number } | null }[];
  requiredDeploymentEnvironments: string[];
  bypassForcePushAllowances: Allowances;
  bypassPullRequestAllowances: Allowances;
  pushAllowances: Allowances;
  reviewDismissalAllowances: Allowances;
};
export type Ruleset = Json & {
  id: number;
  name: string;
  target: string;
  source: string;
  source_type: string;
  enforcement: string;
  conditions?: { ref_name?: { include: string[]; exclude: string[] } };
  bypass_actors?: { actor_id: number | null; actor_type: string; bypass_mode: string }[];
  rules: { type: string; parameters?: Json }[];
};
export type RuleSnapshot = { classic: ClassicRule[]; rulesets: Ruleset[]; problems: string[] };
export type RuleChange = {
  key: string;
  label: string;
  kind: "classic" | "ruleset";
  action: "Add" | "Replace" | "Unchanged";
  before: Json | undefined;
  after: Json;
  targetId?: string | number;
  problems: string[];
  notes: string[];
};
export type CopyPreview = {
  source: string;
  target: string;
  mapDefault: boolean;
  changes: RuleChange[];
  problems: string[];
  fingerprint: string;
};
export type CopyResult = { label: string; status: "applied" | "failed" | "skipped"; message: string };
export type RepositoryConfig = {
  repositories(): Promise<Repository[]>;
  read(repo: string): Promise<Repository>;
  save(repo: string, setting: Setting, value: boolean, previous: boolean): Promise<void>;
  preview(source: string, target: string, mapDefault: boolean): Promise<CopyPreview>;
  apply(preview: CopyPreview, selected: string[]): Promise<CopyResult[]>;
};

const CLASSIC_FIELDS = [
  "allowsDeletions",
  "allowsForcePushes",
  "blocksCreations",
  "dismissesStaleReviews",
  "isAdminEnforced",
  "lockAllowsFetchAndMerge",
  "lockBranch",
  "requireLastPushApproval",
  "requiredApprovingReviewCount",
  "requiresApprovingReviews",
  "requiresCodeOwnerReviews",
  "requiresCommitSignatures",
  "requiresConversationResolution",
  "requiresDeployments",
  "requiresLinearHistory",
  "requiresStatusChecks",
  "requiresStrictStatusChecks",
  "restrictsPushes",
  "restrictsReviewDismissals",
] as const;
const ALLOWANCES = {
  bypassForcePushAllowances: "bypassForcePushActorIds",
  bypassPullRequestAllowances: "bypassPullRequestActorIds",
  pushAllowances: "pushActorIds",
  reviewDismissalAllowances: "reviewDismissalActorIds",
} as const;
const ACTOR_FIELDS = `pageInfo { hasNextPage endCursor } nodes { actor { __typename
  ... on User { id login } ... on Team { id slug } ... on App { id slug } } }`;
const CLASSIC_QUERY = `query RepositoryProtections($owner: String!, $name: String!, $after: String) {
  repository(owner: $owner, name: $name) {
    branchProtectionRules(first: 100, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes { id pattern ${CLASSIC_FIELDS.join(" ")} requiredDeploymentEnvironments
        requiredStatusChecks { context app { id databaseId } }
        ${Object.keys(ALLOWANCES)
          .map((field) => `${field}(first: 100) { ${ACTOR_FIELDS} }`)
          .join("\n")}
      }
    }
  }
}`;

/** Stable keys and set order: reordering a GitHub list isn't a settings change. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).sort().join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

async function graphql<T>(auth: Auth, query: string, variables: Json): Promise<T> {
  const response = query.trimStart().startsWith("mutation")
    ? await send(auth, "graphql", "POST", { query, variables }, "Administration")
    : await auth.github("graphql", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query, variables }),
        cache: "no-cache",
      });
  if (!response.ok) throw new GitHubError("graphql", response.status, await retryAt(response));
  const body = (await response.json()) as { data?: T; errors?: { message: string }[] };
  if (body.errors?.length || !body.data)
    throw new ActionError(body.errors?.map((e) => e.message).join(" ") || "GitHub returned incomplete rule data.");
  return body.data;
}

async function classicRules(auth: Auth, repo: string): Promise<ClassicRule[]> {
  const [owner, name] = repo.split("/");
  const rules: ClassicRule[] = [];
  let after: string | null = null;
  do {
    const data: { repository: { branchProtectionRules: Page<ClassicRule> } | null } = await graphql(
      auth,
      CLASSIC_QUERY,
      { owner, name, after },
    );
    const page: Page<ClassicRule> | undefined = data.repository?.branchProtectionRules;
    if (!page) throw new ActionError("Classic protections could not be read. Administration read access is required.");
    rules.push(...page.nodes);
    if (!page.pageInfo.hasNextPage) return rules;
    if (!page.pageInfo.endCursor || page.pageInfo.endCursor === after)
      throw new ActionError("Classic protection pagination was incomplete.");
    after = page.pageInfo.endCursor;
  } while (after);
  return rules;
}

async function snapshot(auth: Auth, api: Api, repo: string): Promise<RuleSnapshot> {
  const result: RuleSnapshot = { classic: [], rulesets: [], problems: [] };
  await Promise.all([
    classicRules(auth, repo)
      .then((rules) => {
        result.classic = rules;
      })
      .catch((e) => {
        result.problems.push(`Classic protections: ${describeAction(e)}`);
      }),
    (async () => {
      const listed = await api.list<{ id: number }>(`repos/${repo}/rulesets?includes_parents=true`);
      // List responses omit conditions, rules and bypass actors. Never copy a summary.
      result.rulesets = await Promise.all(
        listed.map((rule) => api.get<Ruleset>(`repos/${repo}/rulesets/${rule.id}?includes_parents=true`)),
      );
    })().catch((e) => {
      result.problems.push(`Rulesets: ${describeAction(e)}`);
    }),
  ]);
  result.problems.sort();
  return result;
}

function classicInput(rule: ClassicRule, pattern = rule.pattern): Json {
  const input: Json = { pattern };
  for (const field of CLASSIC_FIELDS) input[field] = rule[field];
  input.requiredDeploymentEnvironments = rule.requiredDeploymentEnvironments ?? [];
  input.requiredStatusChecks = (rule.requiredStatusChecks ?? []).map((check) => ({
    context: check.context,
    appId: check.app?.id ?? null,
  }));
  for (const [field, key] of Object.entries(ALLOWANCES)) {
    const allowances = rule[field] as Allowances;
    input[key] = allowances.nodes.map((one) => one.actor?.id).filter(Boolean);
  }
  return input;
}

function rulesetInput(rule: Ruleset, source: Repository, target: Repository, mapDefault: boolean): Json {
  const conditions = structuredClone(rule.conditions);
  if (mapDefault && conditions?.ref_name) {
    for (const key of ["include", "exclude"] as const) {
      conditions.ref_name[key] = conditions.ref_name[key].map((ref) =>
        ref === `refs/heads/${source.default_branch}` ? `refs/heads/${target.default_branch}` : ref,
      );
    }
  }
  return {
    name: rule.name,
    target: rule.target,
    enforcement: rule.enforcement,
    conditions,
    bypass_actors: rule.bypass_actors,
    rules: rule.rules,
  };
}

const SIMPLE_RULES = new Set([
  "creation",
  "update",
  "deletion",
  "required_linear_history",
  "required_signatures",
  "non_fast_forward",
]);
const PARAMETERS: Record<string, string[]> = {
  pull_request: [
    "dismiss_stale_reviews_on_push",
    "require_code_owner_review",
    "require_last_push_approval",
    "required_approving_review_count",
    "required_review_thread_resolution",
    "allowed_merge_methods",
  ],
  required_status_checks: [
    "required_status_checks",
    "strict_required_status_checks_policy",
    "do_not_enforce_on_create",
  ],
  required_deployments: ["required_deployment_environments"],
  branch_name_pattern: ["name", "negate", "operator", "pattern"],
  commit_message_pattern: ["name", "negate", "operator", "pattern"],
  commit_author_email_pattern: ["name", "negate", "operator", "pattern"],
  committer_email_pattern: ["name", "negate", "operator", "pattern"],
};

/** Only exact identities match. Patterns are never expanded into today's branches. */
export function compareRules(
  source: Repository,
  target: Repository,
  from: RuleSnapshot,
  to: RuleSnapshot,
  mapDefault: boolean,
): RuleChange[] {
  const changes: RuleChange[] = [];
  for (const rule of from.classic) {
    const pattern = mapDefault && rule.pattern === source.default_branch ? target.default_branch : rule.pattern;
    const matches = to.classic.filter((one) => one.pattern === pattern);
    const before = matches[0];
    const problems: string[] = [];
    if (CLASSIC_FIELDS.some((field) => rule[field] === undefined))
      problems.push("GitHub returned incomplete classic protection fields.");
    for (const field of Object.keys(ALLOWANCES) as (keyof typeof ALLOWANCES)[]) {
      if (rule[field].pageInfo.hasNextPage || rule[field].nodes.some((one) => !one.actor))
        problems.push(`${field}: incomplete actor list; copy blocked.`);
    }
    if (before)
      for (const field of Object.keys(ALLOWANCES) as (keyof typeof ALLOWANCES)[]) {
        if (before[field].pageInfo.hasNextPage || before[field].nodes.some((one) => !one.actor))
          problems.push(`Target ${field} is incomplete; replacement blocked.`);
      }
    if (matches.length > 1) problems.push("Multiple target rules have this pattern; choose rules manually on GitHub.");
    if (rule.requiresStatusChecks && !Array.isArray(rule.requiredStatusChecks))
      problems.push("Required status checks were not disclosed; copy blocked.");
    const after = classicInput(rule, pattern);
    changes.push({
      key: `classic:${rule.id}`,
      label: `Classic protection: ${rule.pattern} → ${pattern}`,
      kind: "classic",
      action: before ? (canonical(classicInput(before)) === canonical(after) ? "Unchanged" : "Replace") : "Add",
      before: before ? classicInput(before) : undefined,
      after,
      ...(before ? { targetId: before.id } : {}),
      problems,
      notes: [
        "Only this exact pattern is matched. Other target patterns remain in place; overlapping patterns can affect rule precedence.",
      ],
    });
  }
  for (const rule of from.rulesets) {
    const matches = to.rulesets.filter(
      (one) =>
        one.name === rule.name &&
        one.target === rule.target &&
        one.source_type === "Repository" &&
        one.source.toLowerCase() === target.full_name.toLowerCase(),
    );
    const before = matches[0];
    const after = rulesetInput(rule, source, target, mapDefault);
    const problems: string[] = [];
    if (rule.target !== "branch")
      problems.push(`Unsupported ${rule.target} ruleset; only branch rulesets can be copied here.`);
    if (rule.source_type !== "Repository" || rule.source.toLowerCase() !== source.full_name.toLowerCase())
      problems.push("Inherited organization ruleset; manage it at its source.");
    if (matches.length > 1) problems.push("Ambiguous target ruleset name; copy blocked.");
    if (!Array.isArray(rule.bypass_actors) || (before && !Array.isArray(before.bypass_actors)))
      problems.push("GitHub did not disclose all bypass actors. Administration access is required.");
    if (
      !rule.conditions?.ref_name ||
      Object.keys(rule.conditions).some((key) => key !== "ref_name") ||
      Object.keys(rule.conditions.ref_name).some((key) => key !== "include" && key !== "exclude")
    )
      problems.push("Unsupported or missing ruleset conditions.");
    for (const item of rule.rules) {
      if (
        item.type === "required_status_checks" &&
        ((item.parameters?.required_status_checks ?? []) as Json[]).some((check) =>
          Object.keys(check).some((key) => key !== "context" && key !== "integration_id"),
        )
      )
        problems.push("Unsupported required status check fields.");
      const keys = Object.keys(item.parameters ?? {});
      if (
        !(SIMPLE_RULES.has(item.type)
          ? keys.length === 0
          : PARAMETERS[item.type] && keys.every((key) => PARAMETERS[item.type]?.includes(key)))
      )
        problems.push(`Unsupported rule or parameter: ${item.type}. Copy this ruleset manually on GitHub.`);
      if (Object.keys(item).some((key) => key !== "type" && key !== "parameters"))
        problems.push(`Unsupported fields on ${item.type}.`);
    }
    changes.push({
      key: `ruleset:${rule.id}`,
      label: `Ruleset: ${rule.name}`,
      kind: "ruleset",
      action: before
        ? canonical(rulesetInput(before, target, target, false)) === canonical(after)
          ? "Unchanged"
          : "Replace"
        : "Add",
      before: before ? rulesetInput(before, target, target, false) : undefined,
      after,
      ...(before ? { targetId: before.id } : {}),
      problems,
      notes: [],
    });
  }
  for (const rule of to.classic) {
    if (!changes.some((one) => one.kind === "classic" && one.targetId === rule.id))
      changes.push({
        key: `target-classic:${rule.id}`,
        label: `Target protection: ${rule.pattern}`,
        kind: "classic",
        action: "Unchanged",
        before: classicInput(rule),
        after: classicInput(rule),
        problems: [],
        notes: ["Target-only rule is preserved."],
      });
  }
  for (const rule of to.rulesets) {
    if (!changes.some((one) => one.kind === "ruleset" && one.targetId === rule.id))
      changes.push({
        key: `target-ruleset:${rule.id}`,
        label: `Target ruleset: ${rule.name}`,
        kind: "ruleset",
        action: "Unchanged",
        before: rule,
        after: rule,
        problems: [],
        notes: ["Target-only or inherited ruleset is preserved."],
      });
  }
  for (const change of changes.filter((one) => one.action !== "Unchanged")) {
    if (
      changes.some(
        (other) =>
          other !== change &&
          !other.key.startsWith("target-") &&
          other.kind === change.kind &&
          (change.kind === "classic"
            ? other.after.pattern === change.after.pattern
            : other.after.name === change.after.name),
      )
    )
      change.problems.push("Multiple source rules map to the same target identity; copy blocked.");
  }
  return changes;
}

export function createRepositoryConfig(auth: Auth, dashboard: Dashboard): RepositoryConfig {
  const api = createApi(auth);
  const read = (repo: string) => api.get<Repository>(`repos/${repo}`);
  let applying = false;
  const issued = new WeakMap<CopyPreview, string>();
  async function preview(sourceName: string, targetName: string, mapDefault: boolean): Promise<CopyPreview> {
    if (sourceName.toLowerCase() === targetName.toLowerCase())
      throw new ActionError("Choose a different source repository.");
    const [source, target, from, to] = await Promise.all([
      read(sourceName),
      read(targetName),
      snapshot(auth, api, sourceName),
      snapshot(auth, api, targetName),
    ]);
    const changes = compareRules(source, target, from, to, mapDefault);
    const problems = [...from.problems.map((p) => `Source: ${p}`), ...to.problems.map((p) => `Target: ${p}`)];
    if (!target.permissions?.admin || target.archived)
      problems.push(
        "The target must be writable and you need repository administrator access. The GitHub App needs Administration write access.",
      );
    // Preserve global actor IDs only when they are already authorized on the target.
    const targetActors = new Set<string>();
    for (const rule of to.classic)
      for (const field of Object.keys(ALLOWANCES) as (keyof typeof ALLOWANCES)[])
        for (const one of rule[field].nodes) if (one.actor) targetActors.add(one.actor.id);
    const bypass = new Set(to.rulesets.flatMap((rule) => (rule.bypass_actors ?? []).map((actor) => canonical(actor))));
    const allActors = from.classic.flatMap((rule) =>
      Object.keys(ALLOWANCES).flatMap((field) => (rule[field] as Allowances).nodes.map((one) => one.actor)),
    );
    if (allActors.some((actor) => actor && !targetActors.has(actor.id))) {
      const [users, teams] = await Promise.all([
        api.list<{ node_id: string }>(`repos/${targetName}/collaborators`).catch(() => []),
        api.list<{ node_id: string }>(`repos/${targetName}/teams`).catch(() => []),
      ]);
      for (const actor of [...users, ...teams]) targetActors.add(actor.node_id);
    }
    let teams: { id: number }[] = [];
    if (
      from.rulesets.some((rule) =>
        rule.bypass_actors?.some((actor) => actor.actor_type === "Team" && !bypass.has(canonical(actor))),
      )
    )
      teams = await api.list<{ id: number }>(`repos/${targetName}/teams`).catch(() => []);
    const checks = await targetChecks(api, targetName, target.default_branch);
    for (const change of changes) {
      if (change.key.startsWith("target-") || change.action === "Unchanged") continue;
      if (change.kind === "classic") {
        for (const key of Object.values(ALLOWANCES))
          for (const id of change.after[key] as string[])
            if (!targetActors.has(id))
              change.problems.push(
                `Actor ${id} cannot be verified on the target; no actor will be silently removed or substituted.`,
              );
        for (const check of change.after.requiredStatusChecks as { context: string; appId: string | null }[])
          if (!checks.some((one) => one.context === check.context && (!check.appId || one.nodeId === check.appId)))
            change.problems.push(
              `Required check “${check.context}” has not been observed on the target default branch with the same app. Run it there before copying.`,
            );
        if (change.after.requiresDeployments)
          change.problems.push("Deployment environments need manual verification; copying this protection is blocked.");
      } else {
        for (const actor of (change.after.bypass_actors ?? []) as NonNullable<Ruleset["bypass_actors"]>) {
          if (
            !bypass.has(canonical(actor)) &&
            !(actor.actor_type === "Team" && teams.some((team) => team.id === actor.actor_id))
          )
            change.problems.push(
              `Bypass actor ${actor.actor_type}:${actor.actor_id} is not verified on the target. Configure it on GitHub before copying.`,
            );
        }
        for (const rule of change.after.rules as Ruleset["rules"]) {
          if (rule.type === "required_deployments")
            change.problems.push("Deployment environments need manual verification; this ruleset is blocked.");
          if (rule.type === "required_status_checks")
            for (const check of (rule.parameters?.required_status_checks ?? []) as {
              context: string;
              integration_id?: number | null;
            }[]) {
              if (
                !checks.some(
                  (one) =>
                    one.context === check.context && (!check.integration_id || one.appId === check.integration_id),
                )
              )
                change.problems.push(
                  `Required check “${check.context}” has not been observed on the target with the same app. Run it there before copying.`,
                );
            }
        }
      }
    }
    const result: CopyPreview = {
      source: sourceName,
      target: targetName,
      mapDefault,
      changes,
      problems,
      fingerprint: canonical({ source, target, from, to }),
    };
    issued.set(result, canonical(result));
    return result;
  }
  return {
    read: (repo) => worded(() => read(repo)),
    async repositories() {
      return worded(async () => {
        const installations = await api.list<{ id: number }>("user/installations", "installations");
        const repos = (
          await Promise.all(
            installations.map((one) =>
              api.list<Repository>(`user/installations/${one.id}/repositories`, "repositories"),
            ),
          )
        ).flat();
        return [...new Map(repos.map((repo) => [repo.full_name.toLowerCase(), repo])).values()].sort((a, b) =>
          a.full_name.localeCompare(b.full_name),
        );
      });
    },
    save: (repo, setting, value, previous) =>
      worded(async () => {
        if (!(setting in REPOSITORY_SETTINGS) || typeof value !== "boolean")
          throw new ActionError("Unknown repository setting.");
        const current = await read(repo);
        if (!current.permissions?.admin || current.archived)
          throw new ActionError(
            "Repository administrator access and GitHub App Administration write access are required.",
          );
        if (current[setting] !== previous)
          throw new ActionError("This setting changed on GitHub. Refresh before saving.");
        if (current[setting] === undefined) throw new ActionError("GitHub did not disclose this setting.");
        if (
          !value &&
          ["allow_merge_commit", "allow_squash_merge", "allow_rebase_merge"].includes(setting) &&
          !["allow_merge_commit", "allow_squash_merge", "allow_rebase_merge"].some(
            (key) => key !== setting && current[key as Setting] === true,
          )
        )
          throw new ActionError("Keep at least one merge method enabled.");
        try {
          await send(auth, `repos/${repo}`, "PATCH", { [setting]: value }, "Administration");
        } finally {
          void dashboard.refresh();
        }
      }),
    preview: (source, target, mapDefault) => worded(() => preview(source, target, mapDefault)),
    apply: (plan, selected) =>
      worded(async () => {
        if (applying) throw new ActionError("A rule copy is already in progress.");
        if (issued.get(plan) !== canonical(plan))
          throw new ActionError("Preview is invalid. Preview again before applying.");
        applying = true;
        try {
          const fresh = await preview(plan.source, plan.target, plan.mapDefault);
          if (canonical(fresh) !== canonical(plan))
            throw new ActionError(
              "Rules, permissions, or mappings changed since the preview. Preview again before applying.",
            );
          if (fresh.problems.length) throw new ActionError(fresh.problems.join(" "));
          const chosen = [...new Set(selected)].map((key) => fresh.changes.find((one) => one.key === key));
          if (!chosen.length || chosen.some((one) => !one || one.action === "Unchanged" || one.problems.length))
            throw new ActionError("Select only supported changes from the preview.");
          // Consume before writing: an unknown outcome must never retry a creation automatically.
          issued.delete(plan);
          const results: CopyResult[] = [];
          let stopped = false;
          const target = await read(plan.target);
          for (const change of chosen) {
            if (!change) continue;
            if (stopped) {
              results.push({
                label: change.label,
                status: "skipped",
                message: "Stopped after the previous failure. Preview again to continue safely.",
              });
              continue;
            }
            try {
              // Other administrators can edit while earlier items are being written. Check this identity again.
              const [permission, now] = await Promise.all([read(plan.target), snapshot(auth, api, plan.target)]);
              if (!permission.permissions?.admin || permission.archived || now.problems.length)
                throw new ActionError("Target permissions or rules could not be verified. Preview again.");
              const matching =
                change.kind === "classic"
                  ? now.classic.filter((rule) => rule.pattern === change.after.pattern)
                  : now.rulesets.filter(
                      (rule) =>
                        rule.name === change.after.name &&
                        rule.target === change.after.target &&
                        rule.source_type === "Repository" &&
                        rule.source.toLowerCase() === plan.target.toLowerCase(),
                    );
              const currentRule = matching[0];
              const currentInput = currentRule
                ? change.kind === "classic"
                  ? classicInput(currentRule as ClassicRule)
                  : rulesetInput(currentRule as Ruleset, permission, permission, false)
                : undefined;
              if (
                matching.length > 1 ||
                canonical(currentInput) !== canonical(change.before) ||
                (currentRule && currentRule.id !== change.targetId)
              )
                throw new ActionError("This target rule changed during copying. Preview again before continuing.");
              if (change.kind === "classic") {
                const operation = change.action === "Add" ? "createBranchProtectionRule" : "updateBranchProtectionRule";
                const type =
                  change.action === "Add" ? "CreateBranchProtectionRuleInput" : "UpdateBranchProtectionRuleInput";
                const input = {
                  ...change.after,
                  ...(change.action === "Add"
                    ? { repositoryId: target.node_id }
                    : { branchProtectionRuleId: change.targetId }),
                };
                const written = await graphql<Record<string, { branchProtectionRule?: { id?: string } }>>(
                  auth,
                  `mutation CopyProtection($input: ${type}!) { ${operation}(input: $input) { branchProtectionRule { id } } }`,
                  { input },
                );
                if (!written[operation]?.branchProtectionRule?.id)
                  throw new ActionError(
                    "GitHub did not confirm this rule write. Check the refreshed rules before trying again.",
                  );
              } else {
                await send(
                  auth,
                  `repos/${plan.target}/rulesets${change.action === "Replace" ? `/${change.targetId}` : ""}`,
                  change.action === "Add" ? "POST" : "PUT",
                  change.after,
                  "Administration",
                );
              }
              results.push({ label: change.label, status: "applied", message: "Applied on GitHub." });
            } catch (error) {
              stopped = true;
              results.push({ label: change.label, status: "failed", message: describeAction(error) });
            }
          }
          return results;
        } finally {
          applying = false;
          void dashboard.refresh();
        }
      }),
  };
}

async function targetChecks(
  api: Api,
  repo: string,
  branch: string,
): Promise<{ context: string; appId?: number; nodeId?: string }[]> {
  // Missing evidence blocks the rule rather than weakening its required app restriction.
  const ref = encodeURIComponent(branch);
  const [runs, statuses] = await Promise.all([
    api
      .list<{ name: string; app: { id: number; node_id: string } | null }>(
        `repos/${repo}/commits/${ref}/check-runs`,
        "check_runs",
      )
      .catch(() => []),
    api.list<{ context: string }>(`repos/${repo}/commits/${ref}/statuses`).catch(() => []),
  ]);
  return [
    ...runs.map((run) => ({ context: run.name, ...(run.app ? { appId: run.app.id, nodeId: run.app.node_id } : {}) })),
    ...statuses.map((status) => ({ context: status.context })),
  ];
}
