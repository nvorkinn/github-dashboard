import { useEffect, useRef, useState } from "preact/hooks";
import type { Repository } from "../github/repository_config.ts";
import { MAX_SECRETS, type SecretCopy, type SecretCopyOutcome } from "../github/secret_copy.ts";
import { ConfirmButton, useAction } from "./actions.tsx";
import { Icon } from "./Icon.tsx";

/** Copies Actions secrets from another repository into `repo`. Mounted with a repository key, as the settings are. */
export function SecretCopyCard({
  repo,
  repositories,
  canEdit,
  service,
}: {
  repo: string;
  /** The repositories to copy from: every one but `repo`. */
  repositories: Repository[];
  canEdit: boolean;
  service: SecretCopy;
}) {
  const [source, setSource] = useState("");
  const [names, setNames] = useState<string[]>();
  const [existing, setExisting] = useState<string[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [outcome, setOutcome] = useState<SecretCopyOutcome>();
  const [step, setStep] = useState("");
  const mounted = useRef(true);
  // Only the answer for the source chosen last counts.
  const asked = useRef("");
  const action = useAction();
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  function choose(next: string) {
    setSource(next);
    setNames(undefined);
    setSelected([]);
    setOutcome(undefined);
    asked.current = next;
    if (!next) return;
    action.run("names", async () => {
      const [theirs, ours] = await Promise.all([service.names(next), service.names(repo)]);
      if (mounted.current && asked.current === next) {
        setNames(theirs);
        setExisting(ours);
      }
    });
  }

  return (
    <section class="repository-settings-card repository-copy repository-secrets" aria-labelledby="copy-secrets-heading">
      <header class="repository-card-heading">
        <Icon name="key" size={34} />
        <div>
          <h3 id="copy-secrets-heading">Copy secrets</h3>
          <p>Copy Actions secrets from another repository, without ever seeing their values.</p>
        </div>
      </header>
      {!canEdit && (
        <p class="quiet">Read only. A writable repository and repository administrator access are required.</p>
      )}
      <label class="repository-source">
        <span>Copy secrets from</span>
        <select value={source} disabled={!!action.busy} onChange={(event) => choose(event.currentTarget.value)}>
          <option value="">Choose a repository…</option>
          {repositories.map((one) => (
            <option key={one.full_name} value={one.full_name}>
              {one.full_name}
            </option>
          ))}
        </select>
      </label>
      <p class="repository-mapping-note">
        <Icon name="info" size={20} />
        <span>
          A short-lived branch in the source repository runs a workflow that encrypts the secrets for this repository.
          The branch and its run are removed afterwards. Environment and organisation secrets aren't listed.
        </span>
      </p>
      {action.busy === "names" && <p role="status">Reading secret names…</p>}
      {names?.length === 0 && <p>{source} has no repository secrets.</p>}
      {names && names.length > 0 && (
        <div class="repository-preview">
          <ul class="repository-rule-list">
            {names.map((name) => (
              <li key={name}>
                <label>
                  <input
                    type="checkbox"
                    checked={selected.includes(name)}
                    disabled={!!action.busy || !canEdit}
                    onChange={(event) => {
                      const checked = event.currentTarget.checked;
                      setSelected((all) => (checked ? [...all, name] : all.filter((one) => one !== name)));
                    }}
                  />
                  <span class="badge">{existing.includes(name) ? "Replace" : "Add"}</span> {name}
                </label>
              </li>
            ))}
          </ul>
          <p class="quiet">
            A secret with the same name in {repo} is overwritten, and its old value can't be brought back.
            {selected.length > MAX_SECRETS && ` At most ${MAX_SECRETS} secrets can be copied at a time.`}
          </p>
          <ConfirmButton
            key={selected.join(",")}
            label={`Copy ${selected.length} selected secrets`}
            confirmLabel={`Confirm copy to ${repo}`}
            busyLabel={step || "Copying secrets…"}
            busy={action.busy === "copy"}
            disabled={!canEdit || !!action.busy || !selected.length || selected.length > MAX_SECRETS}
            onConfirm={() =>
              action.run("copy", async () => {
                setOutcome(undefined);
                try {
                  const result = await service.copy(source, repo, selected, (next) => {
                    if (mounted.current) setStep(next);
                  });
                  if (!mounted.current) return;
                  setOutcome(result);
                  setSelected([]);
                  const copied = result.results.filter((one) => one.status === "copied").map((one) => one.name);
                  setExisting((all) => [...new Set([...all, ...copied])]);
                } finally {
                  if (mounted.current) setStep("");
                }
              })
            }
          />
        </div>
      )}
      {outcome && (
        <>
          <ul aria-label="Secret copy results" aria-live="polite" class="repository-results">
            {outcome.results.map((result) => (
              <li key={result.name} class={result.status === "failed" ? "problem" : ""}>
                <strong>
                  {result.name}: {result.status}
                </strong>{" "}
                — {result.message}
              </li>
            ))}
          </ul>
          {outcome.leftover && (
            <p role="alert" class="problem">
              {outcome.leftover}
            </p>
          )}
        </>
      )}
      {action.problem && (
        <p role="alert" class="problem">
          {action.problem}
        </p>
      )}
    </section>
  );
}
