import { createContext } from "preact";
import { useContext, useEffect, useRef, useState } from "preact/hooks";
import type { PullActions, PullRequest, ReadFiles, RunActions } from "../model.ts";

/**
 * What the page can do, beyond showing: GitHub's for real, the demo's on its sample data. Each part is missing where
 * nothing can be done, and the components then show no buttons for it. `files` reads a pull request's changed files;
 * without it they aren't offered.
 */
export type Actions = {
  repositories?: import("../github/repository_config.ts").RepositoryConfig;
  review?: import("../github/review.ts").ReviewService;
  /** On pull requests. */
  pulls?: PullActions;
  /** On release runs and projects. */
  runs?: RunActions;
  /** Reads a pull request's changed files. */
  files?: ReadFiles;
};

export const ActionsContext = createContext<Actions | undefined>(undefined);

export function useActions(): Actions | undefined {
  return useContext(ActionsContext);
}

/** Words for the user from what an action rejected with. */
export function reasonOf(error: unknown): string {
  return error instanceof Error && error.message ? error.message : "That didn't work.";
}

/**
 * Runs one action at a time for a part of the page: `busy` names the one under way, and `problem` says why the last
 * one failed, until the next one starts.
 */
export function useAction(): {
  busy: string | undefined;
  problem: string | undefined;
  run(name: string, task: () => Promise<unknown>): void;
} {
  const [busy, setBusy] = useState<string | undefined>(undefined);
  const [problem, setProblem] = useState<string | undefined>(undefined);
  // Set as soon as one starts, so a second click in the same moment doesn't start another.
  const running = useRef(false);
  return {
    busy,
    problem,
    run(name, task) {
      if (running.current) {
        return;
      }
      running.current = true;
      setBusy(name);
      setProblem(undefined);
      task()
        .catch((error: unknown) => setProblem(reasonOf(error)))
        .finally(() => {
          running.current = false;
          setBusy(undefined);
        });
    },
  };
}

/** How long a confirmation stays offered before it goes back to the plain button. */
export const CONFIRM_MS = 5000;

/**
 * A button for something that can't be undone: the first click turns it into a confirming button and Cancel, for a
 * few seconds, and only the confirming button acts.
 */
export function ConfirmButton({
  label,
  confirmLabel,
  busyLabel,
  busy,
  disabled,
  onConfirm,
}: {
  label: string;
  confirmLabel: string;
  busyLabel: string;
  busy: boolean;
  disabled: boolean;
  onConfirm: () => void;
}) {
  const [asking, setAsking] = useState(false);
  const confirm = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!asking) {
      return;
    }
    // A keyboard user is where the next press confirms, as a mouse user is.
    confirm.current?.focus();
    const timer = setTimeout(() => setAsking(false), CONFIRM_MS);
    return () => clearTimeout(timer);
  }, [asking]);

  if (busy) {
    return (
      <button type="button" class="action action-confirm" disabled>
        {busyLabel}
      </button>
    );
  }
  if (asking) {
    return (
      <>
        <button
          ref={confirm}
          type="button"
          class="action action-confirm"
          disabled={disabled}
          onClick={() => {
            setAsking(false);
            onConfirm();
          }}
        >
          {confirmLabel}
        </button>
        <button type="button" class="action" onClick={() => setAsking(false)}>
          Cancel
        </button>
      </>
    );
  }
  return (
    <button type="button" class="action" disabled={disabled} onClick={() => setAsking(true)}>
      {label}
    </button>
  );
}

/**
 * Turns auto-merge on for a pull request, or off when it is on; the same button on the board and in the review.
 * `onDone` hears whether it is now on, and whether GitHub merged at once instead (see `PullActions.setAutoMerge`).
 */
export function AutoMergeButton({
  pull,
  actions,
  busy,
  disabled,
  run,
  onDone,
}: {
  pull: PullRequest;
  actions: PullActions;
  busy: boolean;
  disabled: boolean;
  run: (name: string, task: () => Promise<unknown>) => void;
  onDone: (result: { enabled: boolean; merged: boolean }) => void;
}) {
  return (
    <button
      type="button"
      class="action"
      disabled={disabled}
      title={
        pull.autoMerge
          ? undefined
          : "Merge once the required checks pass, or now if nothing is required and every check passed"
      }
      onClick={() =>
        run("autoMerge", async () => {
          const enabled = !pull.autoMerge;
          const { merged } = await actions.setAutoMerge(pull, enabled);
          onDone({ enabled, merged });
        })
      }
    >
      {busy ? (pull.autoMerge ? "Turning off…" : "Turning on…") : pull.autoMerge ? "Cancel auto-merge" : "Auto-merge"}
    </button>
  );
}
