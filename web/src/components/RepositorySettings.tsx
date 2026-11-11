import { useEffect, useRef, useState } from "preact/hooks";
import {
  type CopyPreview,
  type CopyResult,
  REPOSITORY_SETTINGS,
  type Repository,
  type RepositoryConfig,
  type RuleChange,
  type Setting,
} from "../github/repository_config.ts";
import { ConfirmButton, reasonOf, useAction } from "./actions.tsx";
import "./RepositorySettings.css";

/** Mounted with a repository key: late answers can never change another repository's settings. */
export function RepositorySettings({ repo, service }: { repo: string; service: RepositoryConfig }) {
  const [current, setCurrent] = useState<Repository>();
  const [repositories, setRepositories] = useState<Repository[]>([]);
  const [readProblem, setReadProblem] = useState("");
  const [listProblem, setListProblem] = useState("");
  const [source, setSource] = useState("");
  const [mapDefault, setMapDefault] = useState(false);
  const [preview, setPreview] = useState<CopyPreview>();
  const [selected, setSelected] = useState<string[]>([]);
  const [results, setResults] = useState<CopyResult[]>([]);
  const [message, setMessage] = useState("");
  const mounted = useRef(true);
  const action = useAction();
  const canEdit = current?.permissions?.admin === true && !current.archived;

  async function refresh() {
    try {
      const value = await service.read(repo);
      if (mounted.current) {
        setCurrent(value);
        setReadProblem("");
      }
    } catch (error) {
      if (mounted.current) {
        setCurrent(undefined);
        setReadProblem(reasonOf(error));
      }
    }
  }
  async function list() {
    try {
      const values = await service.repositories();
      if (mounted.current) {
        setRepositories(values.filter((one) => one.full_name.toLowerCase() !== repo.toLowerCase()));
        setListProblem("");
      }
    } catch (error) {
      if (mounted.current) setListProblem(reasonOf(error));
    }
  }
  // The parent keys this component by repo; clean up all old answers on a scope change.
  useEffect(() => {
    mounted.current = true;
    void refresh();
    void list();
    return () => {
      mounted.current = false;
    };
  }, [repo, service]);

  function invalidate() {
    setPreview(undefined);
    setSelected([]);
    setResults([]);
    setMessage("");
  }

  return (
    <section class="panel settings repository-settings" aria-labelledby="repository-settings-heading">
      <div class="panel-heading">
        <h2 id="repository-settings-heading">Repository settings</h2>
        <button
          type="button"
          disabled={!!action.busy}
          onClick={() =>
            action.run("refresh", async () => {
              invalidate();
              await Promise.all([refresh(), list()]);
            })
          }
        >
          Refresh settings
        </button>
      </div>
      <div class="settings-body">
        <p class="quiet">
          Changes apply to {repo}. The GitHub App needs Administration write access, accepted on its installation.
        </p>
        {readProblem && (
          <p role="alert" class="problem">
            {readProblem}
          </p>
        )}
        {!current && !readProblem && <p role="status">Loading repository settings…</p>}
        {current && (
          <>
            {!canEdit && (
              <p class="quiet">
                Read only. A writable repository and repository administrator access are required to make changes.
              </p>
            )}
            <fieldset disabled={!canEdit || !!action.busy}>
              <legend>Merge settings</legend>
              {(Object.entries(REPOSITORY_SETTINGS) as [Setting, string][]).map(([key, label]) => (
                <label key={key}>
                  <input
                    type="checkbox"
                    checked={current[key] === true}
                    disabled={current[key] === undefined}
                    onChange={() =>
                      action.run(key, async () => {
                        setMessage("");
                        setPreview(undefined);
                        try {
                          await service.save(repo, key, !current[key], current[key] === true);
                          if (mounted.current) setMessage(`${label}: saved.`);
                        } finally {
                          await refresh();
                        }
                      })
                    }
                  />
                  {label}
                  {current[key] === undefined && <span class="quiet"> — unavailable from GitHub</span>}
                </label>
              ))}
            </fieldset>
          </>
        )}
        <section class="repository-copy" aria-labelledby="copy-rules-heading">
          <h3 id="copy-rules-heading">Copy Branch Rules</h3>
          <p class="quiet">
            Preview classic protections and rulesets. Select individual changes; target-only and inherited rules stay in
            place.
          </p>
          {listProblem && (
            <p role="alert" class="problem">
              Repository list: {listProblem}
            </p>
          )}
          <label>
            Source repository
            <select
              value={source}
              disabled={!!action.busy}
              onChange={(event) => {
                setSource(event.currentTarget.value);
                invalidate();
              }}
            >
              <option value="">Choose a repository…</option>
              {repositories.map((one) => (
                <option key={one.full_name} value={one.full_name}>
                  {one.full_name}
                </option>
              ))}
            </select>
          </label>
          <label>
            <input
              type="checkbox"
              checked={mapDefault}
              disabled={!!action.busy}
              onChange={(event) => {
                setMapDefault(event.currentTarget.checked);
                invalidate();
              }}
            />
            Map the source default branch to this repository’s default branch
          </label>
          <p class="quiet">
            Otherwise names stay identical. Only exact default-branch names change; wildcard patterns and
            ~DEFAULT_BRANCH keep their meaning.
          </p>
          <button
            type="button"
            disabled={!source || !!action.busy}
            onClick={() =>
              action.run("preview", async () => {
                invalidate();
                const value = await service.preview(source, repo, mapDefault);
                if (mounted.current) setPreview(value);
              })
            }
          >
            {action.busy === "preview" ? "Reading rules…" : "Preview rules"}
          </button>
          {preview && (
            <div class="repository-preview">
              <p>
                From <strong>{preview.source}</strong> to <strong>{preview.target}</strong>
              </p>
              {preview.problems.map((problem) => (
                <p key={problem} role="alert" class="problem">
                  {problem}
                </p>
              ))}
              {preview.changes.length === 0 && <p>No branch rules found in either repository.</p>}
              <ul class="repository-rule-list">
                {preview.changes.map((change) => (
                  <RuleRow
                    key={change.key}
                    change={change}
                    selected={selected.includes(change.key)}
                    disabled={!!action.busy || !canEdit || !!preview.problems.length}
                    onSelect={(checked) =>
                      setSelected((keys) =>
                        checked ? [...keys, change.key] : keys.filter((key) => key !== change.key),
                      )
                    }
                  />
                ))}
              </ul>
              <p class="quiet">
                Replacements change the entire matched rule. Review the current and proposed values before selecting.
                Copying stops at the first failure; completed changes remain applied.
              </p>
              <ConfirmButton
                key={selected.join(",")}
                label={`Apply ${selected.length} selected changes`}
                confirmLabel={`Confirm copy to ${repo}`}
                busyLabel="Applying rules…"
                busy={action.busy === "apply"}
                disabled={!canEdit || !!action.busy || !selected.length || !!preview.problems.length}
                onConfirm={() =>
                  action.run("apply", async () => {
                    setMessage("");
                    try {
                      const outcome = await service.apply(preview, selected);
                      if (mounted.current) setResults(outcome);
                    } finally {
                      if (mounted.current) {
                        setPreview(undefined);
                        setSelected([]);
                      }
                      await refresh();
                      // Fetch a new comparison after all outcomes, including partial and uncertain writes.
                      try {
                        const next = await service.preview(source, repo, mapDefault);
                        if (mounted.current) setPreview(next);
                      } catch (error) {
                        if (mounted.current) setReadProblem(`Could not refresh rules: ${reasonOf(error)}`);
                      }
                    }
                  })
                }
              />
            </div>
          )}
          {results.length > 0 && (
            <ul aria-label="Copy results" aria-live="polite" class="repository-results">
              {results.map((result) => (
                <li key={result.label} class={result.status === "failed" ? "problem" : ""}>
                  <strong>
                    {result.label}: {result.status}
                  </strong>{" "}
                  — {result.message}
                </li>
              ))}
            </ul>
          )}
        </section>
        {action.problem && (
          <p role="alert" class="problem">
            {action.problem}
          </p>
        )}
        {message && <p role="status">{message}</p>}
      </div>
    </section>
  );
}

function RuleRow({
  change,
  selected,
  disabled,
  onSelect,
}: {
  change: RuleChange;
  selected: boolean;
  disabled: boolean;
  onSelect(checked: boolean): void;
}) {
  const blocked = change.problems.length > 0;
  return (
    <li>
      <label>
        <input
          type="checkbox"
          checked={selected}
          disabled={disabled || blocked || change.action === "Unchanged"}
          onChange={(event) => onSelect(event.currentTarget.checked)}
        />
        <span class="badge">{change.action}</span> {change.label}
        {blocked && <strong> — blocked</strong>}
      </label>
      {change.problems.map((problem) => (
        <p key={problem} class="problem">
          {problem}
        </p>
      ))}
      {change.notes.map((note) => (
        <p key={note} class="quiet">
          {note}
        </p>
      ))}
      <details>
        <summary>Review rule values</summary>
        <div class="repository-rule-diff">
          <div>
            <h4>Current target</h4>
            <pre>{change.before ? JSON.stringify(change.before, null, 2) : "No matching rule"}</pre>
          </div>
          <div>
            <h4>Proposed</h4>
            <pre>{JSON.stringify(change.after, null, 2)}</pre>
          </div>
        </div>
      </details>
    </li>
  );
}
