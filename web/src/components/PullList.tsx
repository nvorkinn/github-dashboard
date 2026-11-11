import { useEffect, useState } from "preact/hooks";
import type { Check, CheckState, PullActions, PullFiles, PullRequest, ReadFiles } from "../model.ts";
import { summarize } from "../model.ts";
import { Ago } from "./Ago.tsx";
import { ConfirmButton, reasonOf, useAction, useActions } from "./actions.tsx";
import { ExternalLink } from "./ExternalLink.tsx";
import type { Tone } from "./state.tsx";
import { labelOf, ToneIcon, toneOf } from "./state.tsx";

export type PullOrder = "newest" | "oldest" | "attention";

const ORDERS: { value: PullOrder; label: string }[] = [
  { value: "newest", label: "Newest first" },
  { value: "oldest", label: "Oldest first" },
  { value: "attention", label: "Attention first" },
];

// A preference, not a secret: fine to keep in the browser.
const ORDER_KEY = "github-dashboard:pull-order";

function rememberedOrder(): PullOrder {
  try {
    const stored = localStorage.getItem(ORDER_KEY);
    return ORDERS.find((order) => order.value === stored)?.value ?? "newest";
  } catch {
    // Storage can be switched off; the default will do.
    return "newest";
  }
}

function rememberOrder(order: PullOrder): void {
  try {
    localStorage.setItem(ORDER_KEY, order);
  } catch {
    // Not remembered, then.
  }
}

/** Where a pull request comes in "attention first": what needs a person before what is merely under way. */
function attention(pull: PullRequest): number {
  const checks = summarize(pull.checks);
  if (checks === "failed" || pull.mergeState === "conflicts") {
    return 0;
  }
  if (checks === "waiting") {
    return 1;
  }
  if (checks === "running") {
    return 2;
  }
  return 3;
}

/** A sorted copy. Within the same attention, the newest comes first. */
export function sortPulls(pulls: PullRequest[], order: PullOrder): PullRequest[] {
  const newest = (a: PullRequest, b: PullRequest) => Date.parse(b.createdAt) - Date.parse(a.createdAt);
  const sorted = [...pulls].sort(newest);
  if (order === "oldest") {
    sorted.reverse();
  }
  if (order === "attention") {
    sorted.sort((a, b) => attention(a) - attention(b));
  }
  return sorted;
}

/**
 * The board's three columns, by what a pull request needs: `ready` can be merged now, `attention` needs someone to
 * fix it (a failed check, a conflict, a base that moved on), and `progress` is everything still under way.
 */
export type PullColumn = "ready" | "progress" | "attention";
type PullFilter = "all" | PullColumn;

const COLUMNS: { value: PullColumn; label: string }[] = [
  { value: "ready", label: "Ready to merge" },
  { value: "progress", label: "In progress" },
  { value: "attention", label: "Needs attention" },
];

export function columnOf(pull: PullRequest): PullColumn {
  const checks = summarize(pull.checks);
  if (checks === "failed" || pull.mergeState === "conflicts" || pull.mergeState === "behind") {
    return "attention";
  }
  if (!pull.draft && pull.mergeState === "clean" && (checks === "passed" || checks === "none")) {
    return "ready";
  }
  return "progress";
}

/**
 * Every open pull request, of all projects, on a board of three columns by what each needs. The columns sit side by
 * side where there is room for them and one under the other where there isn't.
 */
export function PullList({ pulls, now, compact = false }: { pulls: PullRequest[]; now: number; compact?: boolean }) {
  const [order, setOrder] = useState(rememberedOrder);
  const [status, setStatus] = useState<PullFilter>("all");
  const [author, setAuthor] = useState("all");
  const sorted = sortPulls(pulls, order);
  const authors = [...new Set(pulls.map((pull) => pull.author))].sort((a, b) => a.localeCompare(b));
  const effectiveAuthor = author === "all" || authors.includes(author) ? author : "all";
  const filtered = compact
    ? sorted.filter(
        (pull) =>
          (status === "all" || columnOf(pull) === status) &&
          (effectiveAuthor === "all" || pull.author === effectiveAuthor),
      )
    : sorted;

  useEffect(() => {
    if (author !== effectiveAuthor) {
      setAuthor(effectiveAuthor);
    }
  }, [author, effectiveAuthor]);

  return (
    <section class={compact ? "panel pulls pulls-compact" : "panel pulls"} aria-labelledby="pulls-heading">
      <div class="panel-heading">
        <h2 id="pulls-heading">
          {compact ? "Open pull requests" : "Pull requests"} <span class="count">{pulls.length}</span>
        </h2>
        <div class="pull-controls">
          {compact && (
            <>
              <label class="pull-filter">
                <span class="quiet">Status</span>
                <select value={status} onChange={(event) => setStatus(event.currentTarget.value as PullFilter)}>
                  <option value="all">All statuses ({pulls.length})</option>
                  {COLUMNS.map(({ value, label }) => (
                    <option key={value} value={value}>
                      {label} ({pulls.filter((pull) => columnOf(pull) === value).length})
                    </option>
                  ))}
                </select>
              </label>
              <label class="pull-filter">
                <span class="quiet">Author</span>
                <select value={effectiveAuthor} onChange={(event) => setAuthor(event.currentTarget.value)}>
                  <option value="all">All authors ({pulls.length})</option>
                  {authors.map((name) => (
                    <option key={name} value={name}>
                      {name} ({pulls.filter((pull) => pull.author === name).length})
                    </option>
                  ))}
                </select>
              </label>
            </>
          )}
          <label class="order">
            <span class="quiet">Order</span>
            <select
              value={order}
              onChange={(event) => {
                const chosen = event.currentTarget.value as PullOrder;
                setOrder(chosen);
                rememberOrder(chosen);
              }}
            >
              {ORDERS.map(({ value, label }) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>
      {pulls.length === 0 ? (
        <p class="empty">No open pull requests</p>
      ) : compact ? (
        filtered.length === 0 ? (
          <p class="empty">No pull requests match these filters</p>
        ) : (
          <ul class="cards pull-queue" aria-labelledby="pulls-heading">
            {filtered.map((pull) => (
              <PullRow key={`${pull.repo}#${pull.number}`} pull={pull} now={now} foldable />
            ))}
          </ul>
        )
      ) : (
        <div class="board">
          {COLUMNS.map(({ value, label }) => {
            const these = sorted.filter((pull) => columnOf(pull) === value);
            return (
              <div key={value} class={`board-column column-${value}`}>
                <h3 id={`column-${value}`}>
                  {label} <span class="quiet">{these.length}</span>
                </h3>
                {these.length === 0 ? (
                  <p class="column-empty quiet">None</p>
                ) : (
                  <ul class="cards" aria-labelledby={`column-${value}`}>
                    {these.map((pull) => (
                      <PullRow key={`${pull.repo}#${pull.number}`} pull={pull} now={now} foldable />
                    ))}
                  </ul>
                )}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

/** The name without the owner, which is the same for nearly everything on the page. */
export function shortName(repo: string): string {
  return repo.slice(repo.indexOf("/") + 1);
}

/**
 * What an action that went through changed, shown at once rather than when GitHub is read again. Each holds only as
 * long as what was read doesn't say otherwise: auto-merge until the pull request is read again, a merge until its
 * row goes, and an update of the branch until its head is the new commit.
 */
type Done = { of: PullRequest; what: "autoMergeOn" | "autoMergeOff" | "merged" | "updated" };

function stillShown(done: Done | undefined, pull: PullRequest): Done | undefined {
  switch (done?.what) {
    case "autoMergeOn":
    case "autoMergeOff":
      return done.of === pull ? done : undefined;
    case "updated":
      return done.of.sha === pull.sha ? done : undefined;
    default:
      return done;
  }
}

/**
 * One pull request. A `foldable` one starts folded, down to its project, number, title, states and buttons, with a
 * button that unfolds the rest: who opened it and when, its branches, each check and the files changed.
 */
export function PullRow({ pull: read, now, foldable = false }: { pull: PullRequest; now: number; foldable?: boolean }) {
  const [unfolded, setUnfolded] = useState(false);
  const folded = foldable && !unfolded;
  const actions = useActions()?.pulls;
  const readFiles = useActions()?.files;
  const [doneState, setDone] = useState<Done | undefined>(undefined);
  const done = stillShown(doneState, read);
  const pull =
    done?.what === "autoMergeOn" || done?.what === "autoMergeOff"
      ? { ...read, autoMerge: done.what === "autoMergeOn" }
      : read;
  return (
    <li class={`${folded ? "pull pull-folded" : "pull"} pull-${columnOf(pull)}`}>
      {folded ? null : pull.authorAvatarUrl ? (
        <img class="avatar" src={pull.authorAvatarUrl} alt="" width="32" height="32" loading="lazy" />
      ) : (
        <span class="avatar avatar-missing" aria-hidden="true" />
      )}
      <div class="pull-main">
        <div class="pull-head">
          <span class="repo-label" title={pull.repo}>
            {shortName(pull.repo)}
          </span>
          {foldable && (
            <button
              type="button"
              class="fold-toggle"
              aria-expanded={unfolded}
              aria-label={`Details of #${pull.number} in ${shortName(pull.repo)}`}
              title={unfolded ? "Hide details" : "Show details"}
              onClick={() => setUnfolded(!unfolded)}
            />
          )}
        </div>
        <ExternalLink class="pull-title" href={pull.url}>
          <span class="number">#{pull.number}</span> {pull.title}
        </ExternalLink>
        {folded && (
          <p class="pull-compact-meta">
            <code>{pull.head}</code>
            <span>{pull.author}</span>
            <span>
              updated <Ago at={pull.updatedAt} now={now} />
            </span>
          </p>
        )}
        {!folded && (
          <p class="meta">
            <span>{pull.author}</span>
            <span class="branches">
              <code>{pull.head}</code>
              <span aria-hidden="true"> → </span>
              <span class="visually-hidden"> into </span>
              <code>{pull.base}</code>
            </span>
            <span>
              opened <Ago at={pull.createdAt} now={now} />
            </span>
            <span>
              updated <Ago at={pull.updatedAt} now={now} />
            </span>
          </p>
        )}
      </div>
      <div class="pull-badges">
        {pull.draft && <span class="badge">Draft</span>}
        {done?.what === "merged" ? (
          <span class="chip tone-done">
            <ToneIcon tone="done" />
            Merged
          </span>
        ) : done?.what === "updated" ? (
          <span class="chip tone-running">
            <ToneIcon tone="running" />
            Updating branch
          </span>
        ) : (
          <MergeState pull={pull} />
        )}
        {pull.autoMerge && <span class="badge badge-accent">Auto-merge</span>}
      </div>
      <Checks checks={pull.checks} folded={folded} />
      {actions && done?.what !== "merged" && (
        <PullButtons pull={pull} actions={actions} updated={done?.what === "updated"} onDone={setDone} />
      )}
      {readFiles && !folded && <FilesChanged pull={pull} read={readFiles} />}
    </li>
  );
}

/**
 * The buttons for what can be done to a pull request now, and why the last one didn't work. Auto-merge can be turned
 * on for one that isn't a draft, and off for any; a pull request that is ready can be merged, after a confirmation
 * as that can't be undone; one that is behind its base can have its branch updated.
 */
function PullButtons({
  pull,
  actions,
  updated,
  onDone,
}: {
  pull: PullRequest;
  actions: PullActions;
  updated: boolean;
  onDone: (done: Done) => void;
}) {
  const { busy, problem, run } = useAction();
  const canMerge = pull.mergeState === "clean" && !pull.draft;
  const canUpdate = pull.mergeState === "behind" && !updated;
  const canAutoMerge = pull.autoMerge || !pull.draft;
  if (!canMerge && !canUpdate && !canAutoMerge) {
    return null;
  }
  const subject = `#${pull.number} in ${shortName(pull.repo)}`;
  return (
    <div class="pull-actions">
      {/* biome-ignore lint/a11y/useSemanticElements: a fieldset would bring a border and a legend it doesn't need. */}
      <div class="action-buttons" role="group" aria-label={`Actions for ${subject}`}>
        {canMerge && (
          <ConfirmButton
            label="Merge"
            confirmLabel="Confirm merge"
            busyLabel="Merging…"
            busy={busy === "merge"}
            disabled={busy !== undefined}
            onConfirm={() =>
              run("merge", async () => {
                await actions.merge(pull);
                onDone({ of: pull, what: "merged" });
              })
            }
          />
        )}
        {canUpdate && (
          <button
            type="button"
            class="action"
            disabled={busy !== undefined}
            onClick={() =>
              run("update", async () => {
                await actions.updateBranch(pull);
                onDone({ of: pull, what: "updated" });
              })
            }
          >
            {busy === "update" ? "Updating…" : "Update branch"}
          </button>
        )}
        {canAutoMerge && (
          <button
            type="button"
            class="action"
            disabled={busy !== undefined}
            title={
              pull.autoMerge
                ? undefined
                : "Merge once the required checks pass, or now if nothing is required and every check passed"
            }
            onClick={() =>
              run("autoMerge", async () => {
                const enabled = !pull.autoMerge;
                const { merged } = await actions.setAutoMerge(pull, enabled);
                onDone({ of: pull, what: merged ? "merged" : enabled ? "autoMergeOn" : "autoMergeOff" });
              })
            }
          >
            {busy === "autoMerge"
              ? pull.autoMerge
                ? "Turning off…"
                : "Turning on…"
              : pull.autoMerge
                ? "Cancel auto-merge"
                : "Auto-merge"}
          </button>
        )}
      </div>
      {problem && (
        <p class="action-problem" role="alert">
          {problem}
        </p>
      )}
    </div>
  );
}

/** What is known of a pull request's files, for the head commit `sha`. */
type FilesState = { sha: string } & (
  | { status: "loading" }
  | { status: "loaded"; files: PullFiles }
  | { status: "failed"; problem: string }
);

const FILE_STATUS: Record<string, string> = {
  added: "Added",
  modified: "Modified",
  removed: "Removed",
  renamed: "Renamed",
  copied: "Copied",
  changed: "Changed",
  unchanged: "Unchanged",
};

/** The files a pull request changes: read when first opened, and again while open once its head is a new commit. */
function FilesChanged({ pull, read }: { pull: PullRequest; read: ReadFiles }) {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<FilesState | undefined>(undefined);
  const [attempt, setAttempt] = useState(0);
  const { sha } = pull;

  // Not for each new copy of the same pull request: only a new head, or a retry, reads again.
  useEffect(() => {
    if (!open) {
      return;
    }
    let current = true;
    setState((was) => (was?.sha === sha && was.status === "loaded" ? was : { sha, status: "loading" }));
    read(pull).then(
      (files) => current && setState({ sha, status: "loaded", files }),
      (error: unknown) => current && setState({ sha, status: "failed", problem: reasonOf(error) }),
    );
    return () => {
      current = false;
    };
  }, [open, sha, attempt, read]);

  const loaded = state?.sha === sha && state.status === "loaded" ? state.files : undefined;
  const count = loaded ? ` (${loaded.files.length}${loaded.truncated ? "+" : ""})` : "";
  return (
    <details class="pull-files" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>Files changed{count}</summary>
      {state?.status === "failed" ? (
        <div class="files-note" role="alert">
          <p class="problem">Couldn't read the files changed. {state.problem}</p>
          <button type="button" class="action" onClick={() => setAttempt((n) => n + 1)}>
            Try again
          </button>
        </div>
      ) : !loaded ? (
        <p class="files-note quiet">Reading the files changed…</p>
      ) : loaded.files.length === 0 ? (
        <p class="files-note quiet">No files changed</p>
      ) : (
        <ul class="file-list">
          {loaded.files.map((file) => (
            <li key={file.path} class={`file file-${file.status}`}>
              <span class="file-status">{FILE_STATUS[file.status] ?? file.status}</span>
              <span class="file-path">
                {file.previousPath && (
                  <>
                    <span class="quiet">{file.previousPath}</span>
                    <span aria-hidden="true"> → </span>
                    <span class="visually-hidden"> to </span>
                  </>
                )}
                {file.path}
              </span>
              <span class="file-counts">
                <span class="additions">+{file.additions}</span>
                <span class="deletions">−{file.deletions}</span>
              </span>
            </li>
          ))}
          {loaded.truncated && (
            <li class="file-more">
              <ExternalLink href={`${pull.url}/files`}>More files on GitHub</ExternalLink>
            </li>
          )}
        </ul>
      )}
    </details>
  );
}

const MERGE_LOOKS: Record<PullRequest["mergeState"], { tone: Tone; icon: Tone | "behind"; label: string }> = {
  clean: { tone: "done", icon: "done", label: "Ready to merge" },
  conflicts: { tone: "failed", icon: "failed", label: "Conflicts" },
  behind: { tone: "waiting", icon: "behind", label: "Behind base" },
  blocked: { tone: "queued", icon: "skipped", label: "Blocked" },
  unknown: { tone: "queued", icon: "queued", label: "Merge state unknown" },
};

function MergeState({ pull }: { pull: PullRequest }) {
  // A draft can't be merged whatever GitHub says of its branch, so only what its author can act on is shown.
  if (pull.draft && pull.mergeState !== "conflicts" && pull.mergeState !== "behind") {
    return null;
  }
  const look = MERGE_LOOKS[pull.mergeState];
  return (
    <span class={`chip tone-${look.tone}`}>
      <ToneIcon tone={look.icon} />
      {look.label}
    </span>
  );
}

const SUMMARY_LOOKS: Record<Exclude<ReturnType<typeof summarize>, "none">, { tone: Tone; label: string }> = {
  failed: { tone: "failed", label: "Failed" },
  waiting: { tone: "waiting", label: "Waiting" },
  running: { tone: "running", label: "Running" },
  passed: { tone: "done", label: "Passed" },
};

// Failed ones first: they are what the list is opened for.
const CHECK_ORDER: CheckState[] = [
  "failed",
  "cancelled",
  "waiting",
  "running",
  "queued",
  "passed",
  "neutral",
  "skipped",
];

export function sortChecks(checks: Check[]): Check[] {
  return [...checks].sort((a, b) => CHECK_ORDER.indexOf(a.state) - CHECK_ORDER.indexOf(b.state));
}

/** Such as "2 failed, 1 running, 11 done", in the legend's words. */
function tally(checks: Check[]): string {
  const counts = new Map<string, number>();
  for (const check of sortChecks(checks)) {
    const word = labelOf(check.state).toLowerCase();
    counts.set(word, (counts.get(word) ?? 0) + 1);
  }
  return [...counts].map(([word, count]) => `${count} ${word}`).join(", ");
}

/** The checks in one word, and each of them behind it; `folded`, the one word alone. */
function Checks({ checks, folded }: { checks: Check[]; folded: boolean }) {
  const summary = summarize(checks);
  if (summary === "none") {
    return <p class="checks checks-none quiet">No checks</p>;
  }
  const look = SUMMARY_LOOKS[summary];
  if (folded) {
    return (
      <p class="checks">
        <span class={`chip tone-${look.tone}`} title={tally(checks)}>
          <ToneIcon tone={look.tone} />
          <span class="visually-hidden">Checks: </span>
          {look.label}
        </span>
      </p>
    );
  }
  return (
    <details class="checks">
      <summary>
        <span class={`chip tone-${look.tone}`}>
          <ToneIcon tone={look.tone} />
          {look.label}
        </span>
        <span class="quiet tally">{tally(checks)}</span>
      </summary>
      <ul class="check-list">
        {sortChecks(checks).map((check, index) => {
          const tone = toneOf(check.state);
          return (
            // Names can repeat (a matrix, a rerun), so the place in the list is part of the key.
            <li key={`${check.name}:${index}`} class={`tone-${tone}`}>
              <ToneIcon tone={tone} />
              {check.url ? <ExternalLink href={check.url}>{check.name}</ExternalLink> : <span>{check.name}</span>}
              <span class="check-state">{labelOf(check.state)}</span>
            </li>
          );
        })}
      </ul>
    </details>
  );
}
