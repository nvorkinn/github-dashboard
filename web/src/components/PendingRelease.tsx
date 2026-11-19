import { createContext } from "preact";
import { useContext, useEffect, useMemo, useRef, useState } from "preact/hooks";
import { MAX_PENDING_PULLS, pullLabel } from "../../../shared/pending.ts";
import type { PendingRelease, Project, PullRequest } from "../model.ts";
import { reasonOf, useAction, useActions } from "./actions.tsx";
import { ExternalLink } from "./ExternalLink.tsx";
import { ToneIcon } from "./state.tsx";
import "./PendingRelease.css";

/**
 * What the pending releases need of the page: every one the relay keeps (undefined where it keeps none), and the open
 * pull requests and projects that are shown, to pick from.
 */
export type PendingView = { pending: PendingRelease[] | undefined; pulls: PullRequest[]; projects: Project[] };

export const PendingContext = createContext<PendingView | undefined>(undefined);

/** The project's pending release to show: the one that waits or is going out, else the last that ended. */
export function pendingOf(list: PendingRelease[] | undefined, repo: string): PendingRelease | undefined {
  const mine = (list ?? []).filter((one) => one.repo === repo);
  return (
    mine.find((one) => one.state === "waiting" || one.state === "releasing") ??
    mine.sort((a, b) => (b.endedAt ?? "").localeCompare(a.endedAt ?? ""))[0]
  );
}

/** The pending releases that wait for this pull request. */
export function waitingOn(list: PendingRelease[] | undefined, pull: Pick<PullRequest, "repo" | "number">) {
  return (list ?? []).filter(
    (one) =>
      one.state === "waiting" && one.pulls.some((p) => p.repo === pull.repo && p.number === pull.number && !p.merged),
  );
}

function nameOf(repo: string): string {
  return repo.split("/")[1] ?? repo;
}

/**
 * The button that sets up the project's pending release, or changes what it waits for: in the project's release
 * controls, beside Release. Nothing where the relay keeps no pending releases.
 */
export function PendingButton({ project }: { project: Project }) {
  const view = useContext(PendingContext);
  const actions = useActions()?.pending;
  const [open, setOpen] = useState(false);
  if (!view?.pending || !actions) {
    return null;
  }
  const current = pendingOf(view.pending, project.repo);
  const waiting = current?.state === "waiting" ? current : undefined;
  if (current?.state === "releasing") {
    return null;
  }
  return (
    <>
      <button
        type="button"
        class="action"
        title={`Publish the next minor release of ${project.repo} once the pull requests you pick have merged`}
        onClick={() => setOpen(true)}
      >
        {waiting ? "Change PRs…" : "Release after merge…"}
      </button>
      {open && <PendingPicker project={project} waiting={waiting} onClose={() => setOpen(false)} />}
    </>
  );
}

const STATE_LOOKS = {
  waiting: { tone: "waiting", label: "Waiting" },
  releasing: { tone: "running", label: "Releasing" },
  released: { tone: "done", label: "Released" },
  failed: { tone: "failed", label: "Failed" },
  cancelled: { tone: "skipped", label: "Cancelled" },
} as const;

/**
 * The project's pending release, as a line in its release controls: what it waits for and how far that got, or how
 * it ended, with Cancel (or Dismiss, once it ended).
 */
export function PendingStatus({ project }: { project: Project }) {
  const view = useContext(PendingContext);
  const actions = useActions()?.pending;
  const { busy, problem, run } = useAction();
  const one = pendingOf(view?.pending, project.repo);
  if (!one) {
    return null;
  }
  const look = STATE_LOOKS[one.state];
  const merged = one.pulls.filter((p) => p.merged).length;
  const ended = one.state !== "waiting" && one.state !== "releasing";
  return (
    <div class={`pending-status pending-${one.state}`}>
      <p class="pending-line">
        <span class={`chip tone-${look.tone}`}>
          <ToneIcon tone={look.tone} />
          {look.label}
        </span>
        <span class="pending-words">
          {one.state === "waiting" && (
            <>
              Next minor release once{" "}
              {one.pulls.length === 1 ? "this merges" : `all ${one.pulls.length} merge (${merged} merged)`}:
            </>
          )}
          {one.state === "releasing" && <>Publishing {one.tag ?? "the next release"}…</>}
          {one.state === "released" && (
            <>
              {one.url ? <ExternalLink href={one.url}>{one.tag ?? "Release"}</ExternalLink> : one.tag} went out after
              these merged:
            </>
          )}
          {(one.state === "failed" || one.state === "cancelled") && one.problem}
        </span>
      </p>
      <ul class="pending-pulls">
        {one.pulls.map((pull) => (
          <li key={`${pull.repo}#${pull.number}`} class={pull.merged ? "pending-merged" : undefined}>
            <ExternalLink href={`https://github.com/${pull.repo}/pull/${pull.number}`}>
              {pullLabel(pull, one.repo)}
            </ExternalLink>{" "}
            <span class="pending-title">{pull.title}</span>
            {pull.merged && <span class="visually-hidden"> (merged)</span>}
          </li>
        ))}
      </ul>
      {actions && one.state !== "releasing" && (
        <div class="pending-buttons">
          <button
            type="button"
            class="action"
            disabled={busy !== undefined}
            aria-label={`${ended ? "Dismiss" : "Cancel"} the pending release of ${project.name}`}
            onClick={() => run("cancel", () => actions.cancel(one))}
          >
            {busy ? (ended ? "Dismissing…" : "Cancelling…") : ended ? "Dismiss" : "Cancel"}
          </button>
        </div>
      )}
      {problem && (
        <p class="action-problem pending-problem" role="alert">
          {problem}
        </p>
      )}
    </div>
  );
}

/** On a pull request's card: that merging it (with the others) releases a project. */
export function PendingBadges({ pull }: { pull: PullRequest }) {
  const view = useContext(PendingContext);
  return (
    <>
      {waitingOn(view?.pending, pull).map((one) => {
        const others = one.pulls.filter((p) => !p.merged && !(p.repo === pull.repo && p.number === pull.number));
        return (
          <span
            key={one.id}
            class="badge badge-pending"
            title={
              others.length === 0
                ? `Merging it releases ${one.repo}`
                : `${one.repo} is released once this and ${others.map((p) => pullLabel(p, pull.repo)).join(", ")} merge`
            }
          >
            Releases {nameOf(one.repo)}
          </span>
        );
      })}
    </>
  );
}

/**
 * Picks the pull requests a project's release waits for, from every project shown: the project's own first. Opens
 * with what it waits for now, when it does.
 */
function PendingPicker({
  project,
  waiting,
  onClose,
}: {
  project: Project;
  waiting: PendingRelease | undefined;
  onClose: () => void;
}) {
  const view = useContext(PendingContext);
  const actions = useActions()?.pending;
  const dialog = useRef<HTMLDialogElement>(null);
  const [picked, setPicked] = useState<Set<string>>(
    () => new Set((waiting?.pulls ?? []).filter((p) => !p.merged).map((p) => `${p.repo}#${p.number}`)),
  );
  const [filter, setFilter] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | undefined>(undefined);
  useEffect(() => {
    dialog.current?.showModal();
  }, []);

  const groups = useMemo(() => {
    const words = filter.trim().toLowerCase();
    const shown = (view?.pulls ?? []).filter(
      (pull) =>
        !words ||
        pull.title.toLowerCase().includes(words) ||
        `${pull.repo}#${pull.number}`.toLowerCase().includes(words) ||
        pull.author.toLowerCase().includes(words),
    );
    const byRepo = new Map<string, PullRequest[]>();
    for (const pull of shown) {
      byRepo.set(pull.repo, [...(byRepo.get(pull.repo) ?? []), pull]);
    }
    return [...byRepo]
      .sort(([a], [b]) => (a === project.repo ? -1 : b === project.repo ? 1 : nameOf(a).localeCompare(nameOf(b))))
      .map(([repo, pulls]) => ({ repo, pulls: pulls.sort((a, b) => b.number - a.number) }));
  }, [view?.pulls, filter, project.repo]);

  const toggle = (key: string) => {
    const next = new Set(picked);
    if (!next.delete(key)) next.add(key);
    setPicked(next);
  };
  const tooMany = picked.size > MAX_PENDING_PULLS;
  const save = async () => {
    if (!actions || picked.size === 0 || tooMany) return;
    setBusy(true);
    setProblem(undefined);
    try {
      await actions.set(
        project,
        [...picked].map((key) => {
          const [repo = "", number = "0"] = key.split("#");
          return { repo, number: Number(number) };
        }),
      );
      onClose();
    } catch (error) {
      setProblem(reasonOf(error));
      setBusy(false);
    }
  };

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: the click is only the backdrop's; Escape is its keyboard way out.
    <dialog
      ref={dialog}
      class="pending-picker"
      aria-labelledby="pending-picker-title"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === dialog.current) onClose();
      }}
    >
      <header class="pending-picker-header">
        <div>
          <h3 id="pending-picker-title">Release {project.name} after merge</h3>
          <p>
            Once every pull request you pick has merged, the next minor release of {project.repo} goes out. If one
            closes without merging, nothing is released.
          </p>
        </div>
        <button class="pending-picker-close" type="button" onClick={onClose} aria-label="Close">
          ×
        </button>
      </header>
      <div class="pending-picker-filter">
        <input
          type="search"
          placeholder="Filter pull requests"
          aria-label="Filter pull requests"
          value={filter}
          onInput={(event) => setFilter((event.target as HTMLInputElement).value)}
        />
      </div>
      <div class="pending-picker-body">
        {groups.length === 0 && <p class="quiet">No open pull requests{filter ? " match" : ""}.</p>}
        {groups.map((group) => (
          <fieldset key={group.repo} class="pending-group">
            <legend>
              {nameOf(group.repo)}
              {group.repo === project.repo && <span class="quiet"> · this project</span>}
            </legend>
            {group.pulls.map((pull) => {
              const key = `${pull.repo}#${pull.number}`;
              return (
                <label key={key} class="pending-option">
                  <input type="checkbox" checked={picked.has(key)} onChange={() => toggle(key)} />
                  <span class="pending-number">#{pull.number}</span>
                  <span class="pending-option-title">{pull.title}</span>
                  {pull.draft && <span class="badge">Draft</span>}
                  {pull.autoMerge && <span class="badge badge-accent">Auto-merge</span>}
                </label>
              );
            })}
          </fieldset>
        ))}
      </div>
      <footer class="pending-picker-footer">
        <span class="quiet" aria-live="polite">
          {tooMany ? `At most ${MAX_PENDING_PULLS} pull requests.` : `${picked.size} picked`}
        </span>
        {problem && (
          <p class="action-problem" role="alert">
            {problem}
          </p>
        )}
        <div class="pending-picker-buttons">
          <button type="button" class="action" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            class="action primary"
            disabled={busy || picked.size === 0 || tooMany}
            onClick={() => void save()}
          >
            {busy
              ? "Saving…"
              : picked.size === 0
                ? "Pick pull requests"
                : `Release after ${picked.size === 1 ? "it merges" : `all ${picked.size} merge`}`}
          </button>
        </div>
      </footer>
    </dialog>
  );
}
