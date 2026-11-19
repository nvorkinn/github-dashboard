import { useEffect, useId, useRef, useState } from "preact/hooks";
import type { Check, CheckState, PullActions, PullRequest } from "../model.ts";
import { isDependabot, summarize } from "../model.ts";
import { Ago } from "./Ago.tsx";
import { AutoMergeButton, ConfirmButton, useAction, useActions } from "./actions.tsx";
import { type BackgroundEntry, type BackgroundWhat, keyOf, useBackground } from "./background.tsx";
import { ExternalLink } from "./ExternalLink.tsx";
import { PullReview } from "./PullReview.tsx";
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

type SavedPullView = { id: string; status: PullFilter; author: string };

const SAVED_VIEWS_KEY = "github-dashboard:pull-views";
const MAX_SAVED_VIEWS = 8;

const COLUMNS: { value: PullColumn; label: string }[] = [
  { value: "ready", label: "Ready to merge" },
  { value: "progress", label: "In progress" },
  { value: "attention", label: "Needs attention" },
];

function isPullFilter(value: unknown): value is PullFilter {
  return value === "all" || COLUMNS.some((column) => column.value === value);
}

function savedViewId(status: PullFilter, author: string): string {
  return `${status}:${encodeURIComponent(author)}`;
}

function readSavedViews(): SavedPullView[] {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(SAVED_VIEWS_KEY) ?? "[]");
    if (!Array.isArray(stored)) {
      return [];
    }
    const found = new Map<string, SavedPullView>();
    for (const item of stored) {
      if (
        typeof item !== "object" ||
        item === null ||
        !isPullFilter((item as Record<string, unknown>).status) ||
        typeof (item as Record<string, unknown>).author !== "string"
      ) {
        continue;
      }
      const status = (item as { status: PullFilter }).status;
      const author = (item as { author: string }).author.trim();
      if (!author) {
        continue;
      }
      const id = savedViewId(status, author);
      if (!found.has(id)) {
        found.set(id, { id, status, author });
      }
    }
    return [...found.values()].slice(0, MAX_SAVED_VIEWS);
  } catch {
    return [];
  }
}

function writeSavedViews(views: SavedPullView[]): void {
  try {
    localStorage.setItem(SAVED_VIEWS_KEY, JSON.stringify(views.map(({ status, author }) => ({ status, author }))));
  } catch {
    // The view still lasts until this page closes.
  }
}

function savedViewLabel(view: Pick<SavedPullView, "status" | "author">): string {
  const status = view.status === "all" ? undefined : COLUMNS.find((column) => column.value === view.status)?.label;
  if (status && view.author !== "all") {
    return `${status} · ${view.author}`;
  }
  if (status) {
    return status;
  }
  return view.author === "all" ? "All pull requests" : `By ${view.author}`;
}

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
export function PullList({
  pulls,
  now,
  compact = false,
  showRepository = true,
}: {
  pulls: PullRequest[];
  now: number;
  compact?: boolean;
  /** Names each repository in a cross-repository compact list. */
  showRepository?: boolean;
}) {
  const [order, setOrder] = useState(rememberedOrder);
  const [status, setStatus] = useState<PullFilter>("all");
  const [author, setAuthor] = useState("all");
  const [savedViews, setSavedViews] = useState(readSavedViews);
  // A phone folds the filters away behind one button; wider screens always show them.
  const [filtersOpen, setFiltersOpen] = useState(false);
  const controlsId = useId();
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
  const filtering = status !== "all" || effectiveAuthor !== "all";
  const matchingSavedView = savedViews.find((view) => view.status === status && view.author === effectiveAuthor);

  function keepSavedViews(next: SavedPullView[]): void {
    setSavedViews(next);
    writeSavedViews(next);
  }

  function saveCurrentView(): void {
    if ((status === "all" && effectiveAuthor === "all") || matchingSavedView) {
      return;
    }
    const saved = {
      id: savedViewId(status, effectiveAuthor),
      status,
      author: effectiveAuthor,
    };
    keepSavedViews([saved, ...savedViews].slice(0, MAX_SAVED_VIEWS));
  }

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
        {compact && (
          <button
            type="button"
            class={filtering ? "secondary pull-filters-toggle filtering" : "secondary pull-filters-toggle"}
            aria-expanded={filtersOpen}
            aria-controls={controlsId}
            onClick={() => setFiltersOpen(!filtersOpen)}
          >
            Filters
            {filtering && <span class="pull-filters-on"> · on</span>}
          </button>
        )}
        <div
          id={controlsId}
          class={["pull-controls", compact && "pull-controls-folding", filtersOpen && "open"].filter(Boolean).join(" ")}
        >
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
              <div class="pull-saved-views">
                <label class="pull-filter">
                  <span class="quiet">Saved</span>
                  <select
                    aria-label="Apply saved PR view"
                    value=""
                    onChange={(event) => {
                      const saved = savedViews.find((view) => view.id === event.currentTarget.value);
                      if (saved) {
                        setStatus(saved.status);
                        setAuthor(saved.author);
                      }
                    }}
                  >
                    <option value="">Saved views ({savedViews.length})</option>
                    {savedViews.map((view) => (
                      <option key={view.id} value={view.id}>
                        {savedViewLabel(view)}
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  type="button"
                  class="action secondary pull-save-view"
                  disabled={(status === "all" && effectiveAuthor === "all") || matchingSavedView !== undefined}
                  onClick={saveCurrentView}
                >
                  Save view
                </button>
                {matchingSavedView && (
                  <button
                    type="button"
                    class="action secondary pull-remove-view"
                    aria-label={`Remove saved view ${savedViewLabel(matchingSavedView)}`}
                    onClick={() => keepSavedViews(savedViews.filter((view) => view.id !== matchingSavedView.id))}
                  >
                    Remove
                  </button>
                )}
              </div>
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
              <PullRow
                key={`${pull.repo}#${pull.number}`}
                pull={pull}
                reviewPulls={filtered}
                now={now}
                foldable
                showRepository={showRepository}
              />
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
                      <PullRow
                        key={`${pull.repo}#${pull.number}`}
                        pull={pull}
                        reviewPulls={sorted}
                        now={now}
                        foldable
                      />
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
 * row goes, and an update of the branch, or a rebase asked of Dependabot, until its head is a new commit.
 */
type Done = {
  of: PullRequest;
  what: "autoMergeOn" | "autoMergeOff" | "merged" | "merging" | "updated" | "rebaseAsked";
};

/** What an action left running or done by a review that closed shows on the card, as though done on the card. */
function doneInBackground(entry: BackgroundEntry | undefined, of: PullRequest): Done | undefined {
  if (!entry || entry.status === "failed") return undefined;
  if (entry.what === "rebase") return entry.status === "done" ? { of, what: "rebaseAsked" } : undefined;
  if (entry.status === "done" && entry.merged) return { of, what: "merged" };
  return { of, what: entry.what === "merge" ? "merging" : "autoMergeOn" };
}

function stillShown(done: Done | undefined, pull: PullRequest): Done | undefined {
  switch (done?.what) {
    case "autoMergeOn":
    case "autoMergeOff":
      return done.of === pull ? done : undefined;
    case "updated":
    case "rebaseAsked":
      return done.of.sha === pull.sha ? done : undefined;
    default:
      return done;
  }
}

/**
 * One pull request. A `foldable` one starts folded, down to its project, number, title, states and buttons, with a
 * button that unfolds the rest: who opened it and when, its branches and each check.
 */
export function PullRow({
  pull: read,
  reviewPulls,
  now,
  foldable = false,
  showRepository = false,
}: {
  pull: PullRequest;
  reviewPulls?: PullRequest[];
  now: number;
  foldable?: boolean;
  showRepository?: boolean;
}) {
  const [reviewOpen, setReviewOpen] = useState(false);
  const [unfolded, setUnfolded] = useState(false);
  const folded = foldable && !unfolded;
  const actions = useActions()?.pulls;
  const readFiles = useActions()?.files;
  const [doneState, setDoneState] = useState<Done | undefined>(undefined);
  const background = useBackground();
  const inBackground = background?.latest.get(keyOf(read));
  // The pull request as read when the review's action started, so that auto-merge turned on there holds until it is
  // read again, as one turned on here does.
  const startedOn = useRef<{ id: number; of: PullRequest }>(undefined);
  if (inBackground && startedOn.current?.id !== inBackground.id) {
    startedOn.current = { id: inBackground.id, of: read };
  }
  // What was done on the card, or what the review that closed did, whichever came last: one done on the card
  // forgets the other.
  const done = stillShown(
    (startedOn.current && doneInBackground(inBackground, startedOn.current.of)) ?? doneState,
    read,
  );
  const setDone = (next: Done) => {
    background?.forget(read);
    setDoneState(next);
  };
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
            {showRepository && (
              <span class="pull-compact-repo" title={pull.repo}>
                {shortName(pull.repo)}
              </span>
            )}
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
        ) : done?.what === "merging" ? (
          <span class="chip tone-running">
            <ToneIcon tone="running" />
            Merging
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
        {done?.what === "rebaseAsked" && <span class="badge">Rebase requested</span>}
      </div>
      {reviewOpen && <PullReview initial={pull} pulls={reviewPulls ?? [pull]} onClose={() => setReviewOpen(false)} />}
      <Checks checks={pull.checks} folded={folded} />
      <PullButtons
        pull={pull}
        actions={
          done?.what === "merged" || (inBackground?.status === "running" && inBackground.what !== "rebase")
            ? undefined
            : actions
        }
        updated={done?.what === "updated"}
        rebaseAsked={done?.what === "rebaseAsked"}
        running={inBackground?.status === "running" ? inBackground.what : undefined}
        onRebase={
          actions &&
          ((shown: PullRequest) => {
            if (background) {
              background.start(shown, "rebase", async () => {
                await actions.requestRebase(shown);
                return { merged: false };
              });
              return undefined;
            }
            return async () => {
              await actions.requestRebase(shown);
              setDone({ of: shown, what: "rebaseAsked" });
            };
          })
        }
        backgroundProblem={
          inBackground?.status === "failed" && !inBackground.dismissed ? noticeProblem(inBackground) : undefined
        }
        onDone={setDone}
        onReview={readFiles && (() => setReviewOpen(true))}
      />
    </li>
  );
}

/**
 * The buttons for what can be done to a pull request now, and why the last one didn't work. Its changes can be
 * reviewed when the files can be read (`onReview`). With `actions`: auto-merge can be turned on for one that isn't a
 * draft, and off for any; a pull request that is ready can be merged, after a confirmation as that can't be undone;
 * one that is behind its base can have its branch updated; Dependabot can be asked to rebase one of its own. They all
 * sit in the one group, which wraps as a whole rather than letting a button land on the states or checks beside it.
 */
function PullButtons({
  pull,
  actions,
  updated,
  rebaseAsked = false,
  running,
  onDone,
  onRebase,
  onReview,
  backgroundProblem,
}: {
  pull: PullRequest;
  actions: PullActions | undefined;
  updated: boolean;
  /** Dependabot was asked to rebase it, and hasn't pushed the rebase yet. */
  rebaseAsked?: boolean;
  /** What the page is doing for it in the background, which holds the buttons until it is through. */
  running?: BackgroundWhat | undefined;
  onDone: (done: Done) => void;
  /**
   * Asks Dependabot to rebase it: in the background, saying how it went in the corner of the page and on the card,
   * or else gives the task to run here.
   */
  onRebase?: ((pull: PullRequest) => (() => Promise<void>) | undefined) | undefined;
  onReview: (() => void) | undefined;
  /** Why what the review started for it, before it closed, didn't work. */
  backgroundProblem?: string | undefined;
}) {
  const action = useAction();
  const { problem, run } = action;
  const busy = action.busy ?? running;
  const canMerge = actions !== undefined && pull.mergeState === "clean" && !pull.draft;
  const canUpdate = actions !== undefined && pull.mergeState === "behind" && !updated;
  const canAutoMerge = actions !== undefined && (pull.autoMerge || !pull.draft);
  const canRebase = actions !== undefined && onRebase !== undefined && isDependabot(pull) && !rebaseAsked;
  if (!onReview && !canMerge && !canUpdate && !canAutoMerge && !canRebase) {
    return null;
  }
  const subject = `#${pull.number} in ${shortName(pull.repo)}`;
  return (
    <div class="pull-actions">
      {/* biome-ignore lint/a11y/useSemanticElements: a fieldset would bring a border and a legend it doesn't need. */}
      <div class="action-buttons" role="group" aria-label={`Actions for ${subject}`}>
        {onReview && (
          <button type="button" class="action" onClick={onReview}>
            Review changes
          </button>
        )}
        {actions && canMerge && (
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
        {actions && canUpdate && (
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
        {canRebase && (
          <button
            type="button"
            class="action"
            title="Comment “@dependabot rebase” so Dependabot rebases it onto its base"
            disabled={busy !== undefined}
            onClick={() => {
              const task = onRebase(pull);
              if (task) run("rebase", task);
            }}
          >
            {busy === "rebase" ? "Asking…" : "Rebase"}
          </button>
        )}
        {actions && canAutoMerge && (
          <AutoMergeButton
            pull={pull}
            actions={actions}
            busy={busy === "autoMerge"}
            disabled={busy !== undefined}
            run={run}
            onDone={({ enabled, merged }) =>
              onDone({ of: pull, what: merged ? "merged" : enabled ? "autoMergeOn" : "autoMergeOff" })
            }
          />
        )}
      </div>
      {problem ? (
        <p class="action-problem" role="alert">
          {problem}
        </p>
      ) : (
        // The corner of the page has already said it out loud.
        backgroundProblem && <p class="action-problem">{backgroundProblem}</p>
      )}
    </div>
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

function noticeProblem(entry: BackgroundEntry & { status: "failed" }): string {
  if (entry.what === "rebase") return `Rebase request failed: ${entry.problem}`;
  return entry.what === "merge" ? `Merge failed: ${entry.problem}` : `Auto-merge failed: ${entry.problem}`;
}
