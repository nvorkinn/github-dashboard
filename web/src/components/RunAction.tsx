import { useEffect, useRef, useState } from "preact/hooks";

/** How long a question waits for its answer before it goes away by itself, as if cancelled. */
export const CONFIRM_MS = 6000;
/** How long what an action did stays in place of its button, by which time the data shows it. */
export const DONE_MS = 15_000;

/** What an action has to say: that it went through, or why it didn't. */
export type Notice = { text: string; failed: boolean };

export type RunActionProps<T> = {
  /** The button's words. */
  label: string;
  /** The button's name for screen readers, where the words alone don't say what it is about. */
  name?: string;
  /** More about what it does, on hover. */
  title?: string;
  /** The button's words while the action is under way, such as "Approving…". */
  busy: string;
  /** A quieter button, for the less likely choice next to a main one. */
  secondary?: boolean;
  /** Works out what the action is about before asking, such as the release's tag. */
  prepare?: () => Promise<T>;
  /** Asks before acting, in place of the button: the question, given what `prepare` found. Without it, no asking. */
  ask?: (prepared: T) => string;
  /** Does it, and says what was done. Fails with an `Error` whose message is for the user. */
  run: (prepared: T) => Promise<string>;
  /** Where to say what came of it, in place of next to the button: for a button with little room around it. */
  onNotice?: (notice: Notice | undefined) => void;
};

type Phase<T> =
  | { name: "idle" }
  | { name: "preparing" }
  | { name: "asking"; prepared: T; question: string }
  | { name: "busy" }
  | { name: "done"; said: string }
  | { name: "failed"; problem: string };

/**
 * One action's button. While the action runs the button is disabled and says so; one that can't be undone asks
 * first, in place: the button becomes the question with Confirm and Cancel, for a few seconds. What came of it shows
 * next to it, or where `onNotice` puts it.
 */
export function RunAction<T = undefined>(props: RunActionProps<T>) {
  const { label, name, title, busy, secondary, prepare, ask, run, onNotice } = props;
  const [phase, setPhase] = useState<Phase<T>>({ name: "idle" });
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const mounted = useRef(true);
  const confirm = useRef<HTMLButtonElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const restoreFocus = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      clearTimeout(timer.current);
    };
  }, []);

  // The question takes the button's place, and the focus with it.
  useEffect(() => {
    if (phase.name === "asking") {
      confirm.current?.focus();
    } else if ((phase.name === "idle" || phase.name === "failed") && restoreFocus.current) {
      trigger.current?.focus();
      restoreFocus.current = false;
    }
  }, [phase.name]);

  function enter(next: Phase<T>, after?: { ms: number; next: Phase<T> }): void {
    clearTimeout(timer.current);
    if (!mounted.current) {
      return;
    }
    setPhase(next);
    if (next.name === "done" || next.name === "failed") {
      onNotice?.(next.name === "done" ? { text: next.said, failed: false } : { text: next.problem, failed: true });
    } else {
      onNotice?.(undefined);
    }
    if (after) {
      timer.current = setTimeout(() => enter(after.next), after.ms);
    }
  }

  async function start(): Promise<void> {
    restoreFocus.current = document.activeElement === trigger.current;
    let prepared = undefined as T;
    if (prepare) {
      enter({ name: "preparing" });
      try {
        prepared = await prepare();
      } catch (error) {
        enter({ name: "failed", problem: words(error) });
        return;
      }
    }
    if (ask) {
      enter({ name: "asking", prepared, question: ask(prepared) }, { ms: CONFIRM_MS, next: { name: "idle" } });
    } else {
      await go(prepared);
    }
  }

  async function go(prepared: T): Promise<void> {
    enter({ name: "busy" });
    try {
      const said = await run(prepared);
      enter({ name: "done", said }, { ms: DONE_MS, next: { name: "idle" } });
    } catch (error) {
      enter({ name: "failed", problem: words(error) });
    }
  }

  const kind = secondary ? "action secondary" : "action";
  switch (phase.name) {
    case "asking":
      return (
        <span class="action-group asking">
          <span class="action-question">{phase.question}</span>
          <button type="button" class="action action-confirm" ref={confirm} onClick={() => void go(phase.prepared)}>
            Confirm
          </button>
          <button type="button" class="action secondary" onClick={() => enter({ name: "idle" })}>
            Cancel
          </button>
        </span>
      );
    case "preparing":
    case "busy":
      return (
        <span class="action-group">
          <button type="button" class={kind} disabled aria-busy="true">
            {phase.name === "preparing" ? "Checking…" : busy}
          </button>
        </span>
      );
    case "done":
      return onNotice ? null : (
        <span class="action-group">
          <span class="action-done" role="status">
            {phase.said}
          </span>
        </span>
      );
    default:
      return (
        <span class="action-group">
          <button
            type="button"
            class={kind}
            ref={trigger}
            {...(name ? { "aria-label": name } : {})}
            {...(title ? { title } : {})}
            onClick={() => void start()}
          >
            {label}
          </button>
          {phase.name === "failed" && !onNotice && (
            <span class="action-problem" role="alert">
              {phase.problem}
            </span>
          )}
        </span>
      );
  }
}

function words(error: unknown): string {
  return error instanceof Error && error.message
    ? error.message
    : "That didn't work. Check GitHub before trying again.";
}
