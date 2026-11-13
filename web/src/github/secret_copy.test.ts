import { expect, test } from "vitest";
import { parse } from "yaml";
import { BRANCH_PREFIX, courierWorkflow, createSecretCopy, readNotices } from "./secret_copy.ts";
import { fakeGitHub, type Routes } from "./testing.ts";

const SOURCE = "octo/source";
const TARGET = "octo/target";
const NOW = 1_800_000_000_000;
const BRANCH = `${BRANCH_PREFIX}${NOW}`;
/** How a workflow names a secret. */
const value = (name: string) => `\${{ secrets.${name} }}`;
const sealed = (text: string) => `secret-copy:${text}`;

/** A fake GitHub where the pushed workflow runs and says `messages`. */
function github(messages: string[], more: Routes = {}) {
  return fakeGitHub({
    [`repos/${TARGET}/actions/secrets/public-key`]: { key_id: "key-1", key: "a2V5" },
    [`POST repos/${SOURCE}/git/trees`]: { sha: "tree-1" },
    [`POST repos/${SOURCE}/git/commits`]: { sha: "commit-1" },
    [`POST repos/${SOURCE}/git/refs`]: {},
    [`repos/${SOURCE}/actions/runs?head_sha=commit-1&per_page=100`]: {
      workflow_runs: [{ id: 7, status: "completed", conclusion: "success" }],
    },
    [`repos/${SOURCE}/actions/runs/7/jobs`]: { jobs: [{ id: 70 }] },
    [`repos/${SOURCE}/check-runs/70/annotations`]: messages.map((message) => ({ message })),
    [`PUT repos/${TARGET}/actions/secrets/TOKEN`]: () => new Response(null, { status: 201 }),
    [`PUT repos/${TARGET}/actions/secrets/OTHER`]: () => new Response(null, { status: 204 }),
    [`DELETE repos/${SOURCE}/git/refs/heads/${BRANCH}`]: () => new Response(null, { status: 204 }),
    [`DELETE repos/${SOURCE}/actions/runs/7`]: () => new Response(null, { status: 204 }),
    ...more,
  });
}
const service = (auth: ReturnType<typeof fakeGitHub>["auth"], more = {}) =>
  createSecretCopy(auth, { pollMs: 0, now: () => NOW, ...more });

test("the workflow is YAML that hands each secret to its own step and runs on nothing but the push", () => {
  const workflow = parse(courierWorkflow(["TOKEN", "OTHER"], "a2V5+/=="));
  expect(workflow.on).toBe("push");
  expect(workflow.permissions).toEqual({});
  expect(workflow.jobs.seal.env.TARGET_KEY).toBe("a2V5+/==");
  expect(workflow.jobs.seal.env.SEAL).toContain("sodium_crypto_box_seal");
  expect(workflow.jobs.seal.steps).toEqual([
    { name: "TOKEN", env: { SECRET_NAME: "TOKEN", SECRET_VALUE: value("TOKEN") }, run: 'php -r "$SEAL"' },
    { name: "OTHER", env: { SECRET_NAME: "OTHER", SECRET_VALUE: value("OTHER") }, run: 'php -r "$SEAL"' },
  ]);
});

test("nothing but secret names and base64 gets into the workflow", () => {
  expect(() => courierWorkflow(["A }}\n  run: evil"], "a2V5")).toThrow(/isn't a secret name/);
  expect(() => courierWorkflow(["A"], 'a2V5"\n')).toThrow(/isn't base64/);
});

test("a notice is a sealed value only when it is whole", () => {
  const found = readNotices([
    sealed("TOKEN:sealed:4:YWJj"),
    sealed("CUT:sealed:8:YWJj"),
    sealed("GONE:missing"),
    sealed("BARE:no-sodium"),
    "something else",
  ]);
  expect(found.get("TOKEN")).toEqual({ sealed: "YWJj" });
  expect(found.get("CUT")).toEqual({ problem: expect.stringContaining("cut the sealed value short") });
  expect(found.get("GONE")).toEqual({ problem: expect.stringContaining("no value") });
  expect(found.get("BARE")).toEqual({ problem: expect.stringContaining("libsodium") });
  expect(found.size).toBe(4);
});

test("copies through a parentless branch, stores what the runner sealed and tidies up", async () => {
  const { auth, requests } = github([sealed("TOKEN:sealed:4:YWJj"), sealed("OTHER:missing")]);
  const steps: string[] = [];
  const outcome = await service(auth).copy(SOURCE, TARGET, ["TOKEN", "OTHER"], (step) => steps.push(step));
  expect(outcome).toEqual({
    results: [
      { name: "TOKEN", status: "copied", message: "Stored on GitHub." },
      { name: "OTHER", status: "failed", message: expect.stringContaining("no value") },
    ],
    leftover: undefined,
  });
  const writes = requests.filter((one) => one.method !== "GET");
  expect(writes.map((one) => `${one.method} ${one.path}`)).toEqual([
    `POST repos/${SOURCE}/git/trees`,
    `POST repos/${SOURCE}/git/commits`,
    `POST repos/${SOURCE}/git/refs`,
    `PUT repos/${TARGET}/actions/secrets/TOKEN`,
    `DELETE repos/${SOURCE}/git/refs/heads/${BRANCH}`,
    `DELETE repos/${SOURCE}/actions/runs/7`,
  ]);
  const tree = writes[0]?.body as { tree: { path: string; content: string }[]; base_tree?: string };
  expect(tree.base_tree).toBeUndefined();
  expect(tree.tree.map((one) => one.path)).toEqual([".github/workflows/dashboard-secret-copy.yml"]);
  expect(tree.tree[0]?.content).toContain('TARGET_KEY: "a2V5"');
  expect(writes[1]?.body).toMatchObject({ tree: "tree-1", parents: [] });
  expect(writes[2]?.body).toEqual({ ref: `refs/heads/${BRANCH}`, sha: "commit-1" });
  expect(writes[3]?.body).toEqual({ encrypted_value: "YWJj", key_id: "key-1" });
  expect(steps.length).toBe(4);
});

test("waits for the run to finish", async () => {
  let looks = 0;
  const { auth } = github([sealed("TOKEN:sealed:4:YWJj")], {
    [`repos/${SOURCE}/actions/runs?head_sha=commit-1&per_page=100`]: () =>
      Response.json({
        workflow_runs:
          ++looks < 3 ? [] : [{ id: 7, status: looks < 5 ? "in_progress" : "completed", conclusion: null }],
      }),
  });
  const outcome = await service(auth).copy(SOURCE, TARGET, ["TOKEN"]);
  expect(outcome.results[0]?.status).toBe("copied");
  expect(looks).toBe(5);
});

test("a workflow that never starts copies nothing and still removes the branch", async () => {
  let time = NOW;
  const { auth, requests } = github([], {
    [`repos/${SOURCE}/actions/runs?head_sha=commit-1&per_page=100`]: () => {
      time += 60_000;
      return Response.json({ workflow_runs: [] });
    },
  });
  const copy = service(auth, { now: () => time, timeoutMs: 120_000 }).copy(SOURCE, TARGET, ["TOKEN"]);
  await expect(copy).rejects.toThrow(/No workflow started/);
  const writes = requests.filter((one) => one.method !== "GET").map((one) => one.method);
  expect(writes).toEqual(["POST", "POST", "POST", "DELETE"]);
});

test("says what it couldn't remove", async () => {
  const { auth } = github([sealed("TOKEN:sealed:4:YWJj")], {
    [`DELETE repos/${SOURCE}/actions/runs/7`]: () => Response.json({ message: "Nope" }, { status: 403 }),
  });
  const outcome = await service(auth).copy(SOURCE, TARGET, ["TOKEN"]);
  expect(outcome.results[0]?.status).toBe("copied");
  expect(outcome.leftover).toBe(`Couldn't remove its workflow run from ${SOURCE}.`);
});

test("an app without the Secrets permission is told so, before anything is pushed", async () => {
  const { auth, requests } = github([], {
    [`repos/${TARGET}/actions/secrets/public-key`]: () =>
      Response.json({ message: "Resource not accessible by integration" }, { status: 403 }),
  });
  await expect(service(auth).copy(SOURCE, TARGET, ["TOKEN"])).rejects.toThrow(/needs Secrets with write access/);
  expect(requests.every((one) => one.method === "GET")).toBe(true);
});

test("refuses the same repository, no names and too many", async () => {
  const { auth, requests } = github([]);
  const copy = service(auth);
  await expect(copy.copy(SOURCE, "Octo/Source", ["TOKEN"])).rejects.toThrow(/different source/);
  await expect(copy.copy(SOURCE, TARGET, [])).rejects.toThrow(/at least one/);
  const many = Array.from({ length: 41 }, (_, at) => `S${at}`);
  await expect(copy.copy(SOURCE, TARGET, many)).rejects.toThrow(/at most 40/);
  expect(requests).toEqual([]);
});

test("listing names sweeps the branches and runs of copies that never tidied up, and leaves a fresh one", async () => {
  const stale = `${BRANCH_PREFIX}${NOW - 16 * 60_000}`;
  const fresh = `${BRANCH_PREFIX}${NOW - 60_000}`;
  const { auth, requests } = fakeGitHub({
    [`repos/${SOURCE}/actions/secrets`]: { secrets: [{ name: "TOKEN" }, { name: "OTHER" }] },
    [`repos/${SOURCE}/git/matching-refs/heads/${BRANCH_PREFIX}`]: [
      { ref: `refs/heads/${stale}` },
      { ref: `refs/heads/${fresh}` },
    ],
    [`repos/${SOURCE}/actions/runs?branch=${stale}&per_page=100`]: { workflow_runs: [{ id: 3 }] },
    [`DELETE repos/${SOURCE}/git/refs/heads/${stale}`]: () => new Response(null, { status: 204 }),
    [`DELETE repos/${SOURCE}/actions/runs/3`]: () => new Response(null, { status: 204 }),
  });
  expect(await service(auth).names(SOURCE)).toEqual(["TOKEN", "OTHER"]);
  await expect
    .poll(() => requests.filter((one) => one.method === "DELETE").map((one) => one.path))
    .toEqual([`repos/${SOURCE}/git/refs/heads/${stale}`, `repos/${SOURCE}/actions/runs/3`]);
});
