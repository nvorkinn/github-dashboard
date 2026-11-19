import { type ComponentChildren, createContext } from "preact";
import { useContext, useEffect, useRef, useState } from "preact/hooks";
import type { Project, PullRequest } from "../model.ts";
import { reasonOf, useActions } from "./actions.tsx";
import "./PendingRelease.css";

type PullKey = Pick<PullRequest, "repo" | "number">;

/**
 * A release this page makes once some pull requests have merged: `waiting` for them, `releasing`, or `done`, with
 * what came of it. It lives in this tab only, and is gone when the tab closes.
 */
type Pending = {
  project: Project;
  pulls: PullKey[];
  merged: string[];
  state: "waiting" | "releasing" | "done";
  said?: string;
  failed?: boolean;
};

type PendingApi = {
  pulls: PullRequest[];
  of(repo: string): Pending | undefined;
  set(project: Project, pulls: PullKey[]): void;
  cancel(repo: string): void;
};

const PendingContext = createContext<PendingApi | undefined>(undefined);

const keyOf = (pull: PullKey) => `${pull.repo}#${pull.number}`;

/** `#7` for the project's own pull request, `lib#7` for another's. */
function label(pull: PullKey, project: string): string {
  return pull.repo === project ? `#${pull.number}` : `${pull.repo.split("/")[1] ?? pull.repo}#${pull.number}`;
}

/**
 * Keeps this tab's pending releases. Whenever a pull request one waits for leaves the open ones, it asks GitHub
 * whether it merged; once all have, it releases the project with the Release button's action (the next minor). One
 * that closed without merging cancels the release.
 */
export function PendingProvider({ pulls, children }: { pulls: PullRequest[]; children: ComponentChildren }) {
  const actions = useActions();
  const all = useRef(new Map<string, Pending>());
  const asking = useRef(new Set<string>());
  const [, redraw] = useState(0);
  const update = (repo: string, change: Partial<Pending>) => {
    const one = all.current.get(repo);
    if (one) {
      all.current.set(repo, { ...one, ...change });
      redraw((n) => n + 1);
    }
  };

  async function release(one: Pending): Promise<void> {
    const runs = actions?.runs;
    if (!runs) return;
    update(one.project.repo, { state: "releasing" });
    try {
      const tag = await runs.nextRelease(one.project);
      await runs.release(one.project, tag);
      update(one.project.repo, { state: "done", said: `Released ${tag}.` });
    } catch (error) {
      update(one.project.repo, { state: "done", failed: true, said: `Release failed: ${reasonOf(error)}` });
    }
  }

  useEffect(() => {
    const merged = actions?.pulls?.merged;
    if (!merged) return;
    const open = new Set(pulls.map(keyOf));
    for (const one of all.current.values()) {
      if (one.state !== "waiting") continue;
      for (const pull of one.pulls) {
        const key = keyOf(pull);
        if (open.has(key) || one.merged.includes(key) || asking.current.has(`${one.project.repo}>${key}`)) continue;
        asking.current.add(`${one.project.repo}>${key}`);
        void merged(pull)
          .then((yes) => {
            const now = all.current.get(one.project.repo);
            if (now?.state !== "waiting" || now.pulls !== one.pulls) return;
            if (!yes) {
              const said = `${label(pull, now.project.repo)} closed without merging, so nothing was released.`;
              update(now.project.repo, { state: "done", failed: true, said });
              return;
            }
            const done = [...now.merged, key];
            update(now.project.repo, { merged: done });
            if (done.length === now.pulls.length) void release({ ...now, merged: done });
          })
          // Asked again with the next change to the open pull requests.
          .catch(() => {})
          .finally(() => asking.current.delete(`${one.project.repo}>${key}`));
      }
    }
  });

  const api: PendingApi = {
    pulls,
    of: (repo) => all.current.get(repo),
    set(project, picked) {
      all.current.set(project.repo, { project, pulls: picked, merged: [], state: "waiting" });
      redraw((n) => n + 1);
    },
    cancel(repo) {
      all.current.delete(repo);
      redraw((n) => n + 1);
    },
  };
  return <PendingContext.Provider value={api}>{children}</PendingContext.Provider>;
}

/**
 * Beside Release: "Release after merge…", which picks the pull requests to wait for; while it waits, what for, with
 * Cancel; once done, what came of it.
 */
export function ReleaseAfterMerge({ project }: { project: Project }) {
  const pending = useContext(PendingContext);
  const actions = useActions();
  const [open, setOpen] = useState(false);
  if (!pending || !actions?.runs || !actions.pulls?.merged) return null;
  const one = pending.of(project.repo);
  if (one?.state === "waiting" || one?.state === "releasing") {
    return (
      <span class="pending-release">
        <span class="pending-words">
          {one.state === "releasing"
            ? "Releasing…"
            : `Releases once ${one.pulls.map((pull) => label(pull, project.repo)).join(", ")} merge (${one.merged.length} of ${one.pulls.length} merged)`}
        </span>
        {one.state === "waiting" && (
          <button
            type="button"
            class="action"
            aria-label={`Cancel the release of ${project.name} after merge`}
            onClick={() => pending.cancel(project.repo)}
          >
            Cancel
          </button>
        )}
      </span>
    );
  }
  return (
    <>
      <button
        type="button"
        class="action"
        title={`Release ${project.repo} once the pull requests you pick have merged, while this tab stays open`}
        onClick={() => setOpen(true)}
      >
        Release after merge…
      </button>
      {one?.said && (
        <span class={one.failed ? "action-problem pending-said" : "quiet pending-said"} role="status">
          {one.said}
        </span>
      )}
      {open && (
        <Picker
          project={project}
          pulls={pending.pulls}
          onPick={(picked) => pending.set(project, picked)}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

/** Every open pull request shown, grouped by project, the project's own first, to tick the ones to wait for. */
function Picker({
  project,
  pulls,
  onPick,
  onClose,
}: {
  project: Project;
  pulls: PullRequest[];
  onPick: (pulls: PullKey[]) => void;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [picked, setPicked] = useState<PullKey[]>([]);
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  const repos = [...new Set(pulls.map((pull) => pull.repo))].sort((a, b) =>
    a === project.repo ? -1 : b === project.repo ? 1 : a.localeCompare(b),
  );
  const toggle = (pull: PullRequest) =>
    setPicked((now) =>
      now.some((one) => keyOf(one) === keyOf(pull))
        ? now.filter((one) => keyOf(one) !== keyOf(pull))
        : [...now, { repo: pull.repo, number: pull.number }],
    );
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
        <h3 id="pending-picker-title">Release {project.name} after merge</h3>
        <p>
          Once every pull request you pick has merged, this tab releases the next minor version of {project.repo}. Keep
          the tab open until then.
        </p>
      </header>
      <div class="pending-picker-body">
        {repos.length === 0 && <p class="quiet">No open pull requests.</p>}
        {repos.map((repo) => (
          <fieldset key={repo} class="pending-group">
            <legend>{repo.split("/")[1] ?? repo}</legend>
            {pulls
              .filter((pull) => pull.repo === repo)
              .map((pull) => (
                <label key={keyOf(pull)} class="pending-option">
                  <input
                    type="checkbox"
                    checked={picked.some((one) => keyOf(one) === keyOf(pull))}
                    onChange={() => toggle(pull)}
                  />
                  <span class="quiet">#{pull.number}</span>
                  <span class="pending-option-title">{pull.title}</span>
                </label>
              ))}
          </fieldset>
        ))}
      </div>
      <footer class="pending-picker-footer">
        <button type="button" class="action" onClick={onClose}>
          Cancel
        </button>
        <button
          type="button"
          class="action primary"
          disabled={picked.length === 0}
          onClick={() => {
            onPick(picked);
            onClose();
          }}
        >
          {picked.length === 0 ? "Pick pull requests" : `Release after ${picked.length} merge`}
        </button>
      </footer>
    </dialog>
  );
}
