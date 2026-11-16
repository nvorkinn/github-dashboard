import { useState } from "preact/hooks";
import type { Check, CheckState } from "../model.ts";
import { summarize } from "../model.ts";
import { ExternalLink } from "./ExternalLink.tsx";
import { sortChecks } from "./PullList.tsx";
import { labelOf, ToneIcon, toneOf } from "./state.tsx";

import "./ReviewChecks.css";

// A preference, not a secret: fine to keep in the browser, like the diff's font size.
const OPEN_KEY = "github-dashboard:review-checks";

/** Whether the checks were left open last time. Open unless they were closed. */
export function rememberedChecksOpen(): boolean {
  try {
    return localStorage.getItem(OPEN_KEY) !== "closed";
  } catch {
    // Storage can be switched off; open will do.
    return true;
  }
}

export function rememberChecksOpen(open: boolean): void {
  try {
    if (open) {
      localStorage.removeItem(OPEN_KEY);
    } else {
      localStorage.setItem(OPEN_KEY, "closed");
    }
  } catch {
    // Not remembered, then.
  }
}

/** The worst of some checks as one state, to show a workflow's checks by. */
const SUMMARY_STATE: Record<Exclude<ReturnType<typeof summarize>, "none">, CheckState> = {
  failed: "failed",
  waiting: "waiting",
  running: "running",
  passed: "passed",
};

/** The checks with the workflows `workflowsOf` found for them; a check it didn't know of keeps none. */
export function withWorkflows(checks: Check[], workflows: Record<string, string> | undefined): Check[] {
  if (!workflows) return checks;
  return checks.map((check) => {
    const workflow = check.workflow ?? (check.url ? workflows[check.url] : undefined);
    return workflow ? { ...check, workflow } : check;
  });
}

export type CheckGroup = { workflow: string | undefined; checks: Check[] };

/**
 * The checks by workflow, as GitHub's checks page groups them: the workflows with the worst state first, then in the
 * order GitHub gave them, and each one's checks failed first. Checks without one (commit statuses) come last.
 */
export function groupChecks(checks: Check[]): CheckGroup[] {
  const groups = new Map<string | undefined, Check[]>();
  for (const check of checks) {
    const group = groups.get(check.workflow) ?? [];
    group.push(check);
    groups.set(check.workflow, group);
  }
  const rank = (group: Check[]) => ["failed", "waiting", "running", "passed", "none"].indexOf(summarize(group));
  return [...groups]
    .map(([workflow, group], index) => ({ workflow, checks: sortChecks(group), index }))
    .sort(
      (a, b) =>
        Number(a.workflow === undefined) - Number(b.workflow === undefined) ||
        rank(a.checks) - rank(b.checks) ||
        a.index - b.index,
    )
    .map(({ workflow, checks }) => ({ workflow, checks }));
}

/** Such as "2 failed · 11 done": the counts that matter, in the legend's words. */
function tally(checks: Check[]): string {
  const counts = new Map<string, number>();
  for (const check of sortChecks(checks)) {
    const word = labelOf(check.state).toLowerCase();
    counts.set(word, (counts.get(word) ?? 0) + 1);
  }
  return [...counts].map(([word, count]) => `${count} ${word}`).join(" · ");
}

function Chevron() {
  return (
    <svg class="review-chevron" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
      <path d="m6 3.5 4.5 4.5L6 12.5" />
    </svg>
  );
}

function CheckRow({ check }: { check: Check }) {
  const tone = toneOf(check.state);
  const label = labelOf(check.state);
  const body = (
    <>
      <span class="review-chevron-space" />
      <ToneIcon tone={tone} />
      <span class="review-check-name">{check.name}</span>
      {/* Done is what most of them are: the tick says it, and the words would only crowd the ones that aren't. */}
      <span class={tone === "done" ? "visually-hidden" : "review-check-state"}>{label}</span>
    </>
  );
  const title = `${check.name}: ${label}`;
  return (
    <li class={`review-check tone-${tone}`}>
      {check.url ? (
        <ExternalLink href={check.url} title={`${title} (opens on GitHub)`}>
          {body}
        </ExternalLink>
      ) : (
        <span title={title}>{body}</span>
      )}
    </li>
  );
}

/**
 * The pull request's checks, in a drawer at the foot of the file tree: closed, one line that says how they stand;
 * open, every check by workflow, each a link to its log on GitHub. Most pull requests change too few files to fill
 * the tree, so the room below them shows CI instead of nothing.
 */
export function ReviewChecks({ checks }: { checks: Check[] }) {
  const [open, setOpen] = useState(rememberedChecksOpen);
  const summary = summarize(checks);
  const state = summary === "none" ? undefined : SUMMARY_STATE[summary];
  const groups = groupChecks(checks);
  // One workflow needs no heading: the drawer's own says it all.
  const flat = groups.length <= 1;
  return (
    <section class={`review-ci${open ? " review-ci-open" : ""}`} aria-label="Checks">
      <button
        type="button"
        class={`review-ci-toggle${state ? ` tone-${toneOf(state)}` : ""}`}
        aria-expanded={open}
        aria-controls="review-ci-list"
        title={checks.length > 0 ? tally(checks) : "No checks on this commit"}
        onClick={() => {
          setOpen(!open);
          rememberChecksOpen(!open);
        }}
      >
        <Chevron />
        {state ? <ToneIcon tone={toneOf(state)} /> : <span class="review-chevron-space" />}
        <strong>Checks</strong>
        {state && <span class="review-ci-summary">{labelOf(state)}</span>}
        <span class="review-count">{checks.length}</span>
      </button>
      {open && (
        <div id="review-ci-list" class="review-ci-list">
          {checks.length === 0 ? (
            <p class="review-ci-empty">No checks on this commit.</p>
          ) : flat ? (
            <ul>
              {(groups[0]?.checks ?? []).map((check, index) => (
                <CheckRow key={`${check.name}:${index}`} check={check} />
              ))}
            </ul>
          ) : (
            groups.map((group) => {
              const worst = SUMMARY_STATE[summarize(group.checks) as keyof typeof SUMMARY_STATE];
              const name = group.workflow ?? "Other checks";
              return (
                <details key={name} open>
                  <summary class={`tone-${toneOf(worst)}`} title={`${name}: ${tally(group.checks)}`}>
                    <Chevron />
                    <ToneIcon tone={toneOf(worst)} />
                    <span class="review-folder-name">{name}</span>
                    <span class="review-count">{group.checks.length}</span>
                  </summary>
                  <ul class="review-folder">
                    {group.checks.map((check, index) => (
                      <CheckRow key={`${check.name}:${index}`} check={check} />
                    ))}
                  </ul>
                </details>
              );
            })
          )}
        </div>
      )}
    </section>
  );
}
