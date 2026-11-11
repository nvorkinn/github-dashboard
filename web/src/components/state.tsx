import type { CheckState } from "../model.ts";

/**
 * The six looks a state can have, which are the legend's entries. Each has its own colour and its own shape, and is
 * always shown with words, so colour is never the only way to tell them apart.
 */
export type Tone = "done" | "running" | "waiting" | "queued" | "failed" | "skipped";

/** The legend, in the order it is shown. */
export const TONES: { tone: Tone; label: string }[] = [
  { tone: "done", label: "Done" },
  { tone: "running", label: "Running" },
  { tone: "waiting", label: "Waiting for approval" },
  { tone: "queued", label: "Not started" },
  { tone: "failed", label: "Failed" },
  { tone: "skipped", label: "Skipped" },
];

const LOOKS: Record<CheckState, { tone: Tone; label: string }> = {
  passed: { tone: "done", label: "Done" },
  neutral: { tone: "done", label: "Neutral" },
  running: { tone: "running", label: "Running" },
  waiting: { tone: "waiting", label: "Waiting for approval" },
  queued: { tone: "queued", label: "Not started" },
  failed: { tone: "failed", label: "Failed" },
  cancelled: { tone: "failed", label: "Cancelled" },
  skipped: { tone: "skipped", label: "Skipped" },
};

export function toneOf(state: CheckState): Tone {
  return LOOKS[state].tone;
}

export function labelOf(state: CheckState): string {
  return LOOKS[state].label;
}

/** A tone's shape. Decoration only: the words next to it say the same. */
export function ToneIcon({ tone }: { tone: Tone | "behind" }) {
  return (
    <svg class={`icon icon-${tone}`} viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      {tone === "done" && <path d="M3 8.5l3.2 3.2L13 4.8" />}
      {tone === "failed" && <path d="M4 4l8 8M12 4l-8 8" />}
      {tone === "running" && <path d="M8 2a6 6 0 1 0 6 6" />}
      {tone === "waiting" && (
        <>
          <circle cx="8" cy="8" r="6" />
          <path d="M6.5 5.5v5M9.5 5.5v5" />
        </>
      )}
      {tone === "queued" && <circle cx="8" cy="8" r="5" stroke-dasharray="2.6 2.6" />}
      {tone === "skipped" && (
        <>
          <circle cx="8" cy="8" r="6" />
          <path d="M4 12l8-8" />
        </>
      )}
      {tone === "behind" && <path d="M8 3v9M4 8.5l4 4 4-4" />}
    </svg>
  );
}

/** A state as a coloured pill: its shape and, unless `label` gives other words, its name. */
export function StateChip({ state, label }: { state: CheckState; label?: string }) {
  const tone = toneOf(state);
  return (
    <span class={`chip tone-${tone}`}>
      <ToneIcon tone={tone} />
      {label ?? labelOf(state)}
    </span>
  );
}

/** What the colours and shapes mean. */
export function Legend() {
  return (
    <ul class="legend" aria-label="Legend">
      {TONES.map(({ tone, label }) => (
        <li key={tone} class={`tone-${tone}`}>
          <ToneIcon tone={tone} />
          {label}
        </li>
      ))}
    </ul>
  );
}
