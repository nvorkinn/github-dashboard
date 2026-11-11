import { createContext } from "preact";
import { useContext, useEffect, useRef, useState } from "preact/hooks";
import type { PullActions, RunActions } from "../model.ts";

/**
 * What the page can do, beyond showing: GitHub's for real, the demo's on its sample data. Each part is missing where
 * nothing can be done, and the components then show no buttons for it.
 */
export type Actions = {
  /** On pull requests. */
  pulls?: PullActions;
  /** On release runs and projects. */
  runs?: RunActions;
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
