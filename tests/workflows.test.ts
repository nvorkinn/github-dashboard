import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { parse } from "yaml";

// Branch protection requires one check, "Global PR Status", which all-checks.yml completes once every workflow in its
// list has finished. A workflow that runs on pull requests but isn't listed would never re-trigger the gate.
const dir = ".github/workflows";
const workflows = Object.fromEntries(
  readdirSync(dir).map((file) => [file, parse(readFileSync(join(dir, file), "utf8"))]),
);
const gate = workflows["all-checks.yml"];

test("every workflow that runs on pull requests is in the gate's list", () => {
  const listed = new Set<string>(gate.on.workflow_run.workflows);
  const onPullRequests = Object.values(workflows)
    .filter((workflow) => "pull_request" in workflow.on)
    .map((workflow) => workflow.name);
  expect(onPullRequests.length).toBeGreaterThan(0);
  for (const name of onPullRequests) {
    expect(listed, `${name} is missing from all-checks.yml`).toContain(name);
  }
});

test("the shared workflows are pinned to a commit", () => {
  const callers = [gate.jobs["all-checks"], workflows["create_global_pr_status.yml"].jobs["create-global-pr-status"]];
  for (const job of callers) {
    expect(job.uses).toMatch(/^nvorkinn\/\.github\/\.github\/workflows\/[\w-]+\.yml@[0-9a-f]{40}$/);
  }
});

test("the gate approves the pull request", () => {
  expect(gate.jobs["all-checks"].with).toEqual({ approve: true });
});
