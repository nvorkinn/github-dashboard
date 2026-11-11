import { useLayoutEffect, useRef, useState } from "preact/hooks";
import type { Job, JobGraph, ReleaseRun, RunActions } from "../model.ts";
import { type Card, layoutGraph } from "./graph_layout.ts";
import { type Notice, RunAction } from "./RunAction.tsx";
import { labelOf, ToneIcon, toneOf } from "./state.tsx";
import { duration } from "./time.ts";

export type JobsProps = {
  run: ReleaseRun;
  now: number;
  /** The actions for a job that can be re-run; undefined for one that can't. */
  rerunOf: (job: Job) => RunActions | undefined;
  onNotice: (notice: Notice | undefined) => void;
};

/**
 * A run's jobs: on its workflow's graph, in columns left to right by what waits for what, when the workflow file
 * could be read; otherwise in a row, as GitHub lists them.
 */
export function Jobs(props: JobsProps) {
  const { run, now, rerunOf, onNotice } = props;
  if (run.graph && (run.graph.nodes.length > 0 || run.graph.unplaced.length > 0)) {
    return <Graph {...props} graph={run.graph} />;
  }
  if (run.jobs.length === 0) {
    return null;
  }
  return (
    <ul class="jobs" aria-label="Jobs">
      {run.jobs.map((job) => (
        <JobChip key={job.id} job={job} now={now} run={run} rerun={rerunOf(job)} onNotice={onNotice} />
      ))}
    </ul>
  );
}

function Graph({ run, now, rerunOf, onNotice, graph }: JobsProps & { graph: JobGraph }) {
  const { stages, edges } = layoutGraph(graph);
  const inner = useRef<HTMLDivElement>(null);
  const [lines, setLines] = useState<{ width: number; height: number; paths: string[] }>({
    width: 0,
    height: 0,
    paths: [],
  });

  // The lines are drawn where the cards turned out to be, and again whenever that changes.
  const edgeKey = edges.map((edge) => `${edge.from}>${edge.to}`).join(" ");
  const measure = useRef<() => void>(() => {});
  measure.current = () => {
    const box = inner.current;
    if (!box) {
      return;
    }
    const origin = box.getBoundingClientRect();
    const rects = new Map<string, DOMRect>();
    for (const card of box.querySelectorAll<HTMLElement>("[data-card]")) {
      rects.set(card.dataset.card ?? "", card.getBoundingClientRect());
    }
    const paths: string[] = [];
    for (const { from, to } of edges) {
      const a = rects.get(from);
      const b = rects.get(to);
      if (!a || !b || a.width === 0 || b.width === 0) {
        continue;
      }
      const x1 = a.right - origin.left;
      const y1 = a.top + a.height / 2 - origin.top;
      const x2 = b.left - origin.left;
      const y2 = b.top + b.height / 2 - origin.top;
      const bend = Math.max((x2 - x1) / 2, 8);
      paths.push(`M${r(x1)},${r(y1)} C${r(x1 + bend)},${r(y1)} ${r(x2 - bend)},${r(y2)} ${r(x2)},${r(y2)}`);
    }
    const next = { width: Math.ceil(box.scrollWidth), height: Math.ceil(box.scrollHeight), paths };
    setLines((was) =>
      was.width === next.width && was.height === next.height && was.paths.join() === next.paths.join() ? was : next,
    );
  };

  useLayoutEffect(() => {
    measure.current();
  });

  useLayoutEffect(() => {
    const box = inner.current;
    if (!box || typeof ResizeObserver === "undefined") {
      return;
    }
    const observer = new ResizeObserver(() => measure.current());
    observer.observe(box);
    return () => observer.disconnect();
  }, [edgeKey]);

  const finished = run.finishedAt !== undefined;
  return (
    <div class="graph">
      <div class="graph-inner" ref={inner}>
        <svg class="graph-lines" width={lines.width} height={lines.height} aria-hidden="true">
          {lines.paths.map((d) => (
            <path key={d} d={d} />
          ))}
        </svg>
        <ol class="graph-stages" aria-label="Jobs, in the order they run">
          {stages.map((cards, index) => (
            <li key={`stage-${index}`} class="graph-stage">
              <ul class="jobs" aria-label={`Stage ${index + 1}`}>
                {cards.map((card) => (
                  <GraphCard
                    key={card.key}
                    card={card}
                    run={run}
                    now={now}
                    finished={finished}
                    rerunOf={rerunOf}
                    onNotice={onNotice}
                    onToggle={() => measure.current()}
                  />
                ))}
              </ul>
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}

function r(n: number): number {
  return Math.round(n * 10) / 10;
}

function GraphCard({
  card,
  run,
  now,
  finished,
  rerunOf,
  onNotice,
  onToggle,
}: {
  card: Card;
  run: ReleaseRun;
  now: number;
  finished: boolean;
  rerunOf: JobsProps["rerunOf"];
  onNotice: JobsProps["onNotice"];
  onToggle: () => void;
}) {
  switch (card.kind) {
    case "job":
      return (
        <JobChip job={card.job} now={now} run={run} rerun={rerunOf(card.job)} onNotice={onNotice} card={card.key} />
      );
    case "pending": {
      // A job the run never got to, once it has finished.
      const state = finished ? "skipped" : "queued";
      const tone = toneOf(state);
      return (
        <li class={`job tone-${tone}`} title={labelOf(state)} data-card={card.key}>
          <ToneIcon tone={tone} />
          <span>{card.name}</span>
          <span class="visually-hidden">: {labelOf(state)}</span>
        </li>
      );
    }
    case "group": {
      const tone = toneOf(card.state);
      return (
        <li class={`job job-group tone-${tone}`} data-card={card.key}>
          <details onToggle={onToggle}>
            <summary title={labelOf(card.state)}>
              <ToneIcon tone={tone} />
              <span>{card.name}</span>
              <span class="visually-hidden">: {labelOf(card.state)},</span>
              <span class="job-time">
                {card.done}/{card.jobs.length}
                <span class="visually-hidden"> finished</span>
              </span>
            </summary>
            <ul class="jobs">
              {card.jobs.map((job) => (
                <JobChip key={job.id} job={job} now={now} run={run} rerun={rerunOf(job)} onNotice={onNotice} />
              ))}
            </ul>
          </details>
        </li>
      );
    }
  }
}

/** How long a job took or has been going, when that is known. */
function jobTime(job: Job, now: number): string | undefined {
  if (!job.startedAt) {
    return undefined;
  }
  const started = Date.parse(job.startedAt);
  if (job.finishedAt) {
    return duration(Date.parse(job.finishedAt) - started);
  }
  return job.state === "running" ? duration(now - started) : undefined;
}

function JobChip({
  job,
  now,
  run,
  rerun,
  onNotice,
  card,
}: {
  job: Job;
  now: number;
  run: ReleaseRun;
  /** Set where the job can be re-run. */
  rerun: RunActions | undefined;
  onNotice: (notice: Notice | undefined) => void;
  /** Its key on the graph, for the lines to find it. */
  card?: string;
}) {
  const tone = toneOf(job.state);
  const time = jobTime(job, now);
  return (
    <li class={`job tone-${tone}`} title={labelOf(job.state)} {...(card ? { "data-card": card } : {})}>
      <ToneIcon tone={tone} />
      {job.url ? <a href={job.url}>{job.name}</a> : <span>{job.name}</span>}
      {/* The chip's colour and shape, in words, for who can't see them. */}
      <span class="visually-hidden">: {labelOf(job.state)}</span>
      {time && <span class="job-time">{time}</span>}
      {rerun && (
        <RunAction
          label="Re-run"
          name={`Re-run ${job.name}`}
          title="Re-run this job, and the jobs that need it"
          busy="Starting…"
          onNotice={onNotice}
          run={async () => {
            await rerun.rerunJob(run, job);
            return `Re-run of ${job.name} started.`;
          }}
        />
      )}
    </li>
  );
}
