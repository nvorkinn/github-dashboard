import type { Auth } from "../auth.ts";
import { type Api, createApi, GitHubError } from "./api.ts";
import { ActionError, describeAction, send, worded } from "./writes.ts";

/**
 * Copies Actions secrets from one repository to another. GitHub never gives a secret's value back, so a workflow in
 * the source repository carries it: the page pushes a branch that holds nothing but that workflow, the runner seals
 * each secret with the target repository's public key, and the page stores what it sealed in the target. The value
 * itself never leaves the runner; what the page reads only GitHub can open, and only for the target.
 */
export type SecretCopyResult = { name: string; status: "copied" | "failed"; message: string };
export type SecretCopyOutcome = {
  results: SecretCopyResult[];
  /** What was left behind in the source repository, when the tidying up didn't go through. */
  leftover: string | undefined;
};
export type SecretCopy = {
  /** The names of a repository's Actions secrets, in GitHub's order. */
  names(repo: string): Promise<string[]>;
  copy(source: string, target: string, names: string[], progress?: (step: string) => void): Promise<SecretCopyOutcome>;
};

export type SecretCopyOptions = {
  /** How long to wait between looks at the workflow run. */
  pollMs?: number;
  /** How long the workflow run may take in all. */
  timeoutMs?: number;
  now?: () => number;
};

export const BRANCH_PREFIX = "dashboard/secret-copy-";
const WORKFLOW_PATH = ".github/workflows/dashboard-secret-copy.yml";
/** A branch this old belongs to a copy that never tidied up: no run takes this long. */
const STALE_MS = 15 * 60_000;
/** GitHub keeps 50 annotations of a job; each secret is a step with one. */
export const MAX_SECRETS = 40;
const MARK = "secret-copy";
const NEEDS_SECRETS = "The GitHub App needs Secrets with write access, and you need write access to the repository.";

/**
 * Seals `SECRET_VALUE` for the target and says so in a notice, which the page reads as an annotation. The length
 * goes with it, so a notice GitHub cut short is never stored as the secret. PHP, because GitHub's runners have it
 * with libsodium built in: nothing is installed on the way.
 */
const SEAL = [
  '$n = getenv("SECRET_NAME"); $v = getenv("SECRET_VALUE");',
  `if (!function_exists("sodium_crypto_box_seal")) { echo "::notice::${MARK}:$n:no-sodium\\n"; exit(0); }`,
  `if ($v === false || $v === "") { echo "::notice::${MARK}:$n:missing\\n"; exit(0); }`,
  '$c = base64_encode(sodium_crypto_box_seal($v, base64_decode(getenv("TARGET_KEY"))));',
  `echo "::notice::${MARK}:$n:sealed:" . strlen($c) . ":" . $c . "\\n";`,
].join(" ");

/** The workflow that seals `names` with `publicKey`. Both go into YAML as they are, so both are checked first. */
export function courierWorkflow(names: string[], publicKey: string): string {
  if (!/^[A-Za-z0-9+/]+=*$/.test(publicKey)) {
    throw new ActionError("GitHub gave a public key for the target that isn't base64.");
  }
  for (const name of names) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      throw new ActionError(`“${name}” isn't a secret name.`);
    }
  }
  return [
    "# Written by the GitHub dashboard to copy secrets to another repository. The branch is deleted afterwards.",
    "name: Dashboard secret copy",
    "on: push",
    "permissions: {}",
    "jobs:",
    "  seal:",
    "    runs-on: ubuntu-latest",
    "    timeout-minutes: 5",
    "    env:",
    `      TARGET_KEY: "${publicKey}"`,
    `      SEAL: '${SEAL}'`,
    "    steps:",
    ...names.flatMap((name) => [
      `      - name: ${name}`,
      "        env:",
      `          SECRET_NAME: ${name}`,
      `          SECRET_VALUE: \${{ secrets.${name} }}`,
      `        run: php -r "$SEAL"`,
    ]),
    "",
  ].join("\n");
}

/** What the workflow said of each secret: its sealed value, or why there is none. */
export function readNotices(messages: string[]): Map<string, { sealed: string } | { problem: string }> {
  const found = new Map<string, { sealed: string } | { problem: string }>();
  for (const message of messages) {
    const match = new RegExp(`^${MARK}:([A-Za-z0-9_]+):([a-z-]+)(?::(\\d+):([A-Za-z0-9+/=]*))?$`).exec(message.trim());
    if (!match?.[1]) continue;
    const [, name, kind, length, sealed] = match;
    if (kind === "sealed" && sealed && Number(length) === sealed.length) {
      found.set(name, { sealed });
    } else if (kind === "sealed") {
      found.set(name, { problem: "GitHub cut the sealed value short, so it wasn't stored. The secret is too long." });
    } else if (kind === "missing") {
      found.set(name, { problem: "The source repository's workflows get no value for it." });
    } else {
      found.set(name, { problem: "The runner has no libsodium to seal it with." });
    }
  }
  return found;
}

type Run = { id: number; status: string; conclusion: string | null };

export function createSecretCopy(auth: Auth, options: SecretCopyOptions = {}): SecretCopy {
  const api = createApi(auth);
  const pollMs = options.pollMs ?? 3000;
  const timeoutMs = options.timeoutMs ?? 3 * 60_000;
  const now = options.now ?? Date.now;
  const pause = () => new Promise((resolve) => setTimeout(resolve, pollMs));

  /** A read of a repository's secrets; GitHub hides them (403 or 404) from an app without the permission. */
  async function secrets<T>(read: (api: Api) => Promise<T>, repo: string): Promise<T> {
    try {
      return await read(api);
    } catch (error) {
      if (error instanceof GitHubError && error.retryAt === undefined && [403, 404].includes(error.status)) {
        throw new ActionError(`GitHub doesn't show the secrets of ${repo}. ${NEEDS_SECRETS}`);
      }
      throw error;
    }
  }

  async function removeBranch(repo: string, branch: string): Promise<void> {
    await send(auth, `repos/${repo}/git/refs/heads/${branch}`, "DELETE", undefined, "Contents");
  }

  async function removeRun(repo: string, id: number): Promise<void> {
    await send(auth, `repos/${repo}/actions/runs/${id}`, "DELETE", undefined, "Actions");
  }

  /** Removes what copies that never tidied up left in `repo`. Best effort: the next look tries again. */
  async function sweep(repo: string): Promise<void> {
    const refs = await api.list<{ ref: string }>(`repos/${repo}/git/matching-refs/heads/${BRANCH_PREFIX}`);
    for (const { ref } of refs) {
      const branch = ref.replace(/^refs\/heads\//, "");
      const made = Number(branch.slice(BRANCH_PREFIX.length));
      if (!branch.startsWith(BRANCH_PREFIX) || !Number.isFinite(made) || now() - made < STALE_MS) continue;
      const runs = await api.list<Run>(`repos/${repo}/actions/runs?branch=${branch}`, "workflow_runs");
      await removeBranch(repo, branch);
      for (const run of runs) await removeRun(repo, run.id);
    }
  }

  /** The finished run of the commit at `sha`. */
  async function finished(repo: string, sha: string): Promise<Run> {
    const until = now() + timeoutMs;
    let seen = false;
    for (;;) {
      const runs = await api.list<Run>(`repos/${repo}/actions/runs?head_sha=${sha}`, "workflow_runs");
      const run = runs[0];
      seen ||= !!run;
      if (run?.status === "completed") return run;
      if (now() >= until) {
        throw new ActionError(
          seen
            ? "The workflow in the source repository didn't finish in time. Nothing was copied."
            : "No workflow started in the source repository. Are Actions turned on there? Nothing was copied.",
        );
      }
      await pause();
    }
  }

  /** The notices of a run. They can trail the run's end by a moment, so a few looks until all of `names` are there. */
  async function notices(repo: string, run: Run, names: string[]) {
    let found = new Map<string, { sealed: string } | { problem: string }>();
    for (let look = 0; look < 3; look++) {
      if (look > 0) await pause();
      const jobs = await api.list<{ id: number }>(`repos/${repo}/actions/runs/${run.id}/jobs`, "jobs");
      const messages: string[] = [];
      for (const job of jobs) {
        const annotations = await api.list<{ message?: string }>(`repos/${repo}/check-runs/${job.id}/annotations`);
        messages.push(...annotations.map((one) => one.message ?? ""));
      }
      found = readNotices(messages);
      if (names.every((name) => found.has(name))) break;
    }
    return found;
  }

  return {
    names: (repo) =>
      worded(async () => {
        // Whoever looks at a repository's secrets here may be about to copy from it.
        void sweep(repo).catch(() => {});
        const all = await secrets(
          (api) => api.list<{ name: string }>(`repos/${repo}/actions/secrets`, "secrets"),
          repo,
        );
        return all.map((one) => one.name);
      }),

    copy: (source, target, names, progress = () => {}) =>
      worded(async () => {
        if (source.toLowerCase() === target.toLowerCase()) {
          throw new ActionError("Choose a different source repository.");
        }
        if (!names.length) throw new ActionError("Choose at least one secret.");
        if (names.length > MAX_SECRETS) throw new ActionError(`Copy at most ${MAX_SECRETS} secrets at a time.`);

        progress("Reading the target's key…");
        const key = await secrets(
          (api) => api.get<{ key_id: string; key: string }>(`repos/${target}/actions/secrets/public-key`),
          target,
        );
        const workflow = courierWorkflow(names, key.key);

        // A commit with no parent and no other file: no other workflow of the repository runs for this branch.
        progress("Starting the workflow…");
        const branch = `${BRANCH_PREFIX}${now()}`;
        const tree = (await (
          await send(
            auth,
            `repos/${source}/git/trees`,
            "POST",
            { tree: [{ path: WORKFLOW_PATH, mode: "100644", type: "blob", content: workflow }] },
            "Contents",
          )
        ).json()) as { sha: string };
        const commit = (await (
          await send(
            auth,
            `repos/${source}/git/commits`,
            "POST",
            { message: "Copy secrets to another repository", tree: tree.sha, parents: [] },
            "Contents",
          )
        ).json()) as { sha: string };
        await send(
          auth,
          `repos/${source}/git/refs`,
          "POST",
          { ref: `refs/heads/${branch}`, sha: commit.sha },
          "Contents and Workflows",
        );

        let run: Run | undefined;
        const results: SecretCopyResult[] = [];
        let failure: unknown;
        try {
          progress("Waiting for the workflow…");
          run = await finished(source, commit.sha);
          const found = await notices(source, run, names);
          progress("Storing the secrets…");
          for (const name of names) {
            const notice = found.get(name);
            if (!notice || "problem" in notice) {
              const message = notice?.problem ?? `The workflow said nothing of it (it ended as ${run.conclusion}).`;
              results.push({ name, status: "failed", message });
              continue;
            }
            try {
              await send(
                auth,
                `repos/${target}/actions/secrets/${name}`,
                "PUT",
                { encrypted_value: notice.sealed, key_id: key.key_id },
                "Secrets",
              );
              results.push({ name, status: "copied", message: "Stored on GitHub." });
            } catch (error) {
              results.push({ name, status: "failed", message: describeAction(error) });
            }
          }
        } catch (error) {
          failure = error;
        }

        // Whatever happened, the branch and its run go. What stays is swept the next time someone looks.
        const left: string[] = [];
        await removeBranch(source, branch).catch(() => left.push(`the branch ${branch}`));
        if (run) await removeRun(source, run.id).catch(() => left.push("its workflow run"));
        if (failure) throw failure;
        return {
          results,
          leftover: left.length ? `Couldn't remove ${left.join(" and ")} from ${source}.` : undefined,
        };
      }),
  };
}
