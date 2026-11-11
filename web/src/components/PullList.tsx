import { useState } from "preact/hooks";
import type { Check, CheckState, PullRequest } from "../model.ts";
import { summarize } from "../model.ts";
import { Ago } from "./Ago.tsx";
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

/** Every open pull request, of all projects, in one list. */
export function PullList({ pulls, now }: { pulls: PullRequest[]; now: number }) {
  const [order, setOrder] = useState(rememberedOrder);

  return (
    <section class="panel" aria-labelledby="pulls-heading">
      <div class="panel-heading">
        <h2 id="pulls-heading">
          Open pull requests <span class="count">{pulls.length}</span>
        </h2>
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
      {pulls.length === 0 ? (
        <p class="empty">No open pull requests</p>
      ) : (
        <ul class="rows">
          {sortPulls(pulls, order).map((pull) => (
            <PullRow key={`${pull.repo}#${pull.number}`} pull={pull} now={now} />
          ))}
        </ul>
      )}
    </section>
  );
}

/** The name without the owner, which is the same for nearly everything on the page. */
export function shortName(repo: string): string {
  return repo.slice(repo.indexOf("/") + 1);
}

function PullRow({ pull, now }: { pull: PullRequest; now: number }) {
  return (
    <li class="pull">
      {pull.authorAvatarUrl ? (
        <img class="avatar" src={pull.authorAvatarUrl} alt="" width="32" height="32" loading="lazy" />
      ) : (
        <span class="avatar avatar-missing" aria-hidden="true" />
      )}
      <div class="pull-main">
        <span class="repo-label" title={pull.repo}>
          {shortName(pull.repo)}
        </span>
        <a class="pull-title" href={pull.url}>
          <span class="number">#{pull.number}</span> {pull.title}
        </a>
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
      </div>
      <div class="pull-badges">
        {pull.draft && <span class="badge">Draft</span>}
        <MergeState pull={pull} />
        {pull.autoMerge && <span class="badge badge-accent">Auto-merge</span>}
      </div>
      <Checks checks={pull.checks} />
    </li>
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

/** The checks in one word, and each of them behind it. */
function Checks({ checks }: { checks: Check[] }) {
  const summary = summarize(checks);
  if (summary === "none") {
    return <p class="checks checks-none quiet">No checks</p>;
  }
  const look = SUMMARY_LOOKS[summary];
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
              {check.url ? <a href={check.url}>{check.name}</a> : <span>{check.name}</span>}
              <span class="check-state">{labelOf(check.state)}</span>
            </li>
          );
        })}
      </ul>
    </details>
  );
}
