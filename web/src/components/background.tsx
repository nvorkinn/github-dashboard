import { type ComponentChildren, createContext } from "preact";
import { useCallback, useContext, useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { PullRequest } from "../model.ts";
import { reasonOf } from "./actions.tsx";

/** The pull request actions that carry on after the review that started them closes. */
export type BackgroundWhat = "merge" | "autoMerge";

/**
 * One such action: under way, gone through (`merged` when the pull request merged, which turning auto-merge on does
 * when nothing has to pass first), or failed with the `problem`, which stays until dismissed.
 */
export type BackgroundEntry = {
  id: number;
  pull: PullRequest;
  what: BackgroundWhat;
  /** Its notice was closed, or timed out; its card still shows what it did. */
  dismissed?: boolean;
} & ({ status: "running" } | { status: "done"; merged: boolean } | { status: "failed"; problem: string });

export type Background = {
  /** The latest action on each pull request, by `keyOf`. */
  latest: ReadonlyMap<string, BackgroundEntry>;
  start(pull: PullRequest, what: BackgroundWhat, task: () => Promise<{ merged: boolean }>): void;
  /** Forgets the latest action on the pull request, as one started on its card replaces it. */
  forget(pull: PullRequest): void;
};

export const BackgroundContext = createContext<Background | undefined>(undefined);

export function useBackground(): Background | undefined {
  return useContext(BackgroundContext);
}

export function keyOf(pull: Pick<PullRequest, "repo" | "number">): string {
  return `${pull.repo}#${pull.number}`;
}

/** How long a notice of an action that went through stays up. */
export const DONE_NOTICE_MS = 5000;

/**
 * Runs pull request actions that shouldn't hold the review open, for the page below it: their cards show how each is
 * going, and a corner of the page says so too, so a failure is seen wherever the pull request is or isn't shown.
 */
export function BackgroundProvider({ children }: { children: ComponentChildren }) {
  const [entries, setEntries] = useState<BackgroundEntry[]>([]);
  const next = useRef(0);
  const update = useCallback((id: number, change: (entry: BackgroundEntry) => BackgroundEntry) => {
    setEntries((all) => all.map((entry) => (entry.id === id ? change(entry) : entry)));
  }, []);
  const start = useCallback<Background["start"]>(
    (pull, what, task) => {
      const id = next.current++;
      setEntries((all) => [
        ...all.filter((entry) => keyOf(entry.pull) !== keyOf(pull)),
        { id, pull, what, status: "running" },
      ]);
      // A task that throws before its first await rejects all the same.
      Promise.resolve()
        .then(task)
        .then(
          ({ merged }) => update(id, (entry) => ({ ...entry, status: "done", merged })),
          (error: unknown) => update(id, (entry) => ({ ...entry, status: "failed", problem: reasonOf(error) })),
        );
    },
    [update],
  );
  const forget = useCallback((pull: PullRequest) => {
    setEntries((all) => all.filter((entry) => keyOf(entry.pull) !== keyOf(pull)));
  }, []);
  const dismiss = useCallback((id: number) => update(id, (entry) => ({ ...entry, dismissed: true })), [update]);
  const value = useMemo<Background>(
    () => ({ latest: new Map(entries.map((entry) => [keyOf(entry.pull), entry])), start, forget }),
    [entries, start, forget],
  );
  return (
    <BackgroundContext.Provider value={value}>
      {children}
      <BackgroundNotices entries={entries} onDismiss={dismiss} />
    </BackgroundContext.Provider>
  );
}

function subjectOf(pull: PullRequest): string {
  return `#${pull.number} in ${pull.repo.slice(pull.repo.indexOf("/") + 1)}`;
}

/** What the corner says of an action. */
export function noticeOf(entry: BackgroundEntry): string {
  const subject = subjectOf(entry.pull);
  if (entry.status === "running") {
    return entry.what === "merge" ? `Merging ${subject}…` : `Turning on auto-merge for ${subject}…`;
  }
  if (entry.status === "done") {
    return entry.merged ? `Merged ${subject}` : `Auto-merge is on for ${subject}`;
  }
  return entry.what === "merge"
    ? `Couldn't merge ${subject}: ${entry.problem}`
    : `Couldn't turn on auto-merge for ${subject}: ${entry.problem}`;
}

function BackgroundNotices({ entries, onDismiss }: { entries: BackgroundEntry[]; onDismiss: (id: number) => void }) {
  return (
    <div class="background-notices">
      {/* Polite for progress; a failure is its own alert below, so it is read out at once. */}
      <ul class="background-list" aria-live="polite">
        {entries
          .filter((entry) => !entry.dismissed)
          .map((entry) => (
            <BackgroundNotice key={entry.id} entry={entry} onDismiss={onDismiss} />
          ))}
      </ul>
    </div>
  );
}

function BackgroundNotice({ entry, onDismiss }: { entry: BackgroundEntry; onDismiss: (id: number) => void }) {
  useEffect(() => {
    if (entry.status !== "done") return;
    const timer = setTimeout(() => onDismiss(entry.id), DONE_NOTICE_MS);
    return () => clearTimeout(timer);
  }, [entry.status, entry.id, onDismiss]);
  return (
    <li class={`background-notice background-${entry.status}`} role={entry.status === "failed" ? "alert" : undefined}>
      <span class="background-text">{noticeOf(entry)}</span>
      {entry.status !== "running" && (
        <button
          type="button"
          class="background-dismiss"
          aria-label={`Dismiss: ${noticeOf(entry)}`}
          onClick={() => onDismiss(entry.id)}
        >
          ×
        </button>
      )}
    </li>
  );
}
