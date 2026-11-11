import { useState } from "preact/hooks";

/**
 * The two ways to lay out the dashboard. `stage`: pull requests, then running workflows, then the projects.
 * `lanes`: one lane per project, holding its own of each.
 */
export type View = "stage" | "lanes";

const VIEWS: { value: View; label: string; title: string }[] = [
  { value: "stage", label: "Stage", title: "Pull requests, then running workflows, then projects" },
  { value: "lanes", label: "Lanes", title: "One lane per project" },
];

// A preference, not a secret: fine to keep in the browser.
const VIEW_KEY = "github-dashboard:view";

export function rememberedView(): View {
  try {
    const stored = localStorage.getItem(VIEW_KEY);
    return VIEWS.find((view) => view.value === stored)?.value ?? "stage";
  } catch {
    // Storage can be switched off; the default will do.
    return "stage";
  }
}

function rememberView(view: View): void {
  try {
    localStorage.setItem(VIEW_KEY, view);
  } catch {
    // Not remembered, then.
  }
}

/** The chosen view, as the browser remembers it, and a way to choose another that it then remembers. */
export function useView(): [View, (view: View) => void] {
  const [view, setView] = useState(rememberedView);
  return [
    view,
    (chosen) => {
      setView(chosen);
      rememberView(chosen);
    },
  ];
}

/** How many lanes stand side by side on a wide screen. */
export type LaneColumns = 1 | 2;

const LANE_COLUMNS_KEY = "github-dashboard:lane-columns";

export function rememberedLaneColumns(): LaneColumns {
  try {
    return localStorage.getItem(LANE_COLUMNS_KEY) === "1" ? 1 : 2;
  } catch {
    return 2;
  }
}

/** The chosen number of lane columns, as the browser remembers it, and a way to choose the other. */
export function useLaneColumns(): [LaneColumns, (columns: LaneColumns) => void] {
  const [columns, setColumns] = useState(rememberedLaneColumns);
  return [
    columns,
    (chosen) => {
      setColumns(chosen);
      try {
        localStorage.setItem(LANE_COLUMNS_KEY, String(chosen));
      } catch {
        // Not remembered, then.
      }
    },
  ];
}

/** Two buttons side by side, the pressed one being the view shown. */
export function ViewSwitch({ view, onChange }: { view: View; onChange: (view: View) => void }) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: a fieldset would bring a border and a legend it doesn't need.
    <div class="view-switch" role="group" aria-label="View">
      {VIEWS.map(({ value, label, title }) => (
        <button key={value} type="button" aria-pressed={view === value} title={title} onClick={() => onChange(value)}>
          {label}
        </button>
      ))}
    </div>
  );
}
