import { useLayoutEffect, useRef, useState } from "preact/hooks";
import type { Job, JobGraph, ReleaseRun, RunActions } from "../model.ts";
import { ExternalLink } from "./ExternalLink.tsx";
import { type Card, isLive, isTick, layoutGraph, pickShape } from "./graph_layout.ts";
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
 * A run's jobs: on its workflow's graph by what waits for what, when the workflow file could be read; otherwise in a
 * row, as GitHub lists them. The graph takes the shape that suits it and its room (see `pickShape`): across, a
 * timeline, or top to bottom. Jobs that finished well shrink to ticks, so the running or waiting ones stand out.
 */
export function Jobs(props: JobsProps) {
  const { run, now, rerunOf, onNotice } = props;
  const [selectedId, setSelectedId] = useState<number | undefined>(undefined);
  const selected = run.jobs.find((job) => job.id === selectedId);
  const select = (job: Job) => setSelectedId((current) => (current === job.id ? undefined : job.id));
  const content = (() => {
    if (run.graph && (run.graph.nodes.length > 0 || run.graph.unplaced.length > 0)) {
      return <Graph {...props} graph={run.graph} selectedId={selectedId} onSelect={select} />;
    }
    if (run.jobs.length === 0) {
      return null;
    }
    return (
      <ul class="jobs" aria-label="Jobs">
        {run.jobs.map((job) => (
          <JobChip key={job.id} job={job} now={now} run={run} selected={selectedId === job.id} onSelect={select} />
        ))}
      </ul>
    );
  })();
  return (
    <>
      {content}
      {selected && (
        <JobDetails
          job={selected}
          run={run}
          now={now}
          rerun={rerunOf(selected)}
          onNotice={onNotice}
          onClose={() => setSelectedId(undefined)}
        />
      )}
    </>
  );
}

function Graph({
  run,
  now,
  graph,
  selectedId,
  onSelect,
}: JobsProps & { graph: JobGraph; selectedId: number | undefined; onSelect: (job: Job) => void }) {
  const layout = layoutGraph(graph);
  const { stages, edges } = layout;
  const outer = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState<number | undefined>(undefined);
  const shape = pickShape(layout, width);
  const [lines, setLines] = useState<{ width: number; height: number; paths: string[] }>({
    width: 0,
    height: 0,
    paths: [],
  });

  // The lines are drawn where the cards turned out to be, and again whenever that changes. A timeline draws its own.
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
    for (const { from, to } of shape === "timeline" ? [] : edges) {
      const a = rects.get(from);
      const b = rects.get(to);
      if (!a || !b || a.width === 0 || b.width === 0) {
        continue;
      }
      paths.push(shape === "row" ? across(a, b, origin) : down(a, b, origin));
    }
    // Measure the content box, not scrollWidth: the previous SVG size can otherwise
    // keep the graph wide after the viewport shrinks.
    const next = { width: Math.ceil(origin.width), height: Math.ceil(origin.height), paths };
    setLines((was) =>
      was.width === next.width && was.height === next.height && was.paths.join() === next.paths.join() ? was : next,
    );
  };

  useLayoutEffect(() => {
    measure.current();
  });

  // The space the graph has decides its shape; the cards moving, how its lines run.
  useLayoutEffect(() => {
    const room = outer.current;
    const box = inner.current;
    if (!room || !box || typeof ResizeObserver === "undefined") {
      return;
    }
    const observer = new ResizeObserver(() => {
      setWidth(room.clientWidth || undefined);
      measure.current();
    });
    observer.observe(room);
    observer.observe(box);
    return () => observer.disconnect();
  }, [edgeKey]);

  const finished = run.finishedAt !== undefined;
  return (
    <div class={`graph graph-${shape}`} ref={outer}>
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
                    selectedId={selectedId}
                    onSelect={onSelect}
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

/** A line from the right of one card to the left of the next. */
function across(a: DOMRect, b: DOMRect, origin: DOMRect): string {
  const x1 = a.right - origin.left;
  const y1 = a.top + a.height / 2 - origin.top;
  const x2 = b.left - origin.left;
  const y2 = b.top + b.height / 2 - origin.top;
  const bend = Math.max((x2 - x1) / 2, 8);
  return `M${r(x1)},${r(y1)} C${r(x1 + bend)},${r(y1)} ${r(x2 - bend)},${r(y2)} ${r(x2)},${r(y2)}`;
}

/** A line from the bottom of one card to the top of the next. */
function down(a: DOMRect, b: DOMRect, origin: DOMRect): string {
  const x1 = a.left + a.width / 2 - origin.left;
  const y1 = a.bottom - origin.top;
  const x2 = b.left + b.width / 2 - origin.left;
  const y2 = b.top - origin.top;
  const bend = Math.max((y2 - y1) / 2, 8);
  return `M${r(x1)},${r(y1)} C${r(x1)},${r(y1 + bend)} ${r(x2)},${r(y2 - bend)} ${r(x2)},${r(y2)}`;
}

function r(n: number): number {
  return Math.round(n * 10) / 10;
}

function GraphCard({
  card,
  run,
  now,
  finished,
  selectedId,
  onSelect,
}: {
  card: Card;
  run: ReleaseRun;
  now: number;
  finished: boolean;
  selectedId: number | undefined;
  onSelect: (job: Job) => void;
}) {
  switch (card.kind) {
    case "job":
      return (
        <JobChip
          job={card.job}
          now={now}
          run={run}
          selected={selectedId === card.job.id}
          onSelect={onSelect}
          card={card.key}
        />
      );
    case "pending": {
      // A job the run never got to, once it has finished.
      const state = finished ? "skipped" : "queued";
      const tone = toneOf(state);
      return (
        <li class={`job tone-${tone}${finished ? " job-tick" : ""}`} title={labelOf(state)} data-card={card.key}>
          <ToneIcon tone={tone} />
          <span>{card.name}</span>
          <span class="visually-hidden">: {labelOf(state)}</span>
        </li>
      );
    }
    case "group": {
      const tone = toneOf(card.state);
      return (
        <li class={`job-matrix tone-${tone}${isLive(card.state) ? " job-live" : ""}`} data-card={card.key}>
          <p class="job-matrix-head" title={labelOf(card.state)}>
            <ToneIcon tone={tone} />
            <span class="job-matrix-name">{card.name}</span>
            <span class="visually-hidden">: {labelOf(card.state)},</span>
            <span class="job-matrix-count">
              {card.done} of {card.jobs.length} done
            </span>
          </p>
          <ul class="jobs job-grid">
            {card.jobs.map((job) => (
              <JobChip
                key={job.id}
                job={job}
                now={now}
                run={run}
                selected={selectedId === job.id}
                onSelect={onSelect}
                compact
                matrix={card.name}
              />
            ))}
          </ul>
        </li>
      );
    }
  }
}

/**
 * A job's name, and in its matrix's grid only the part that differs: `esp32-c3` of `build (esp32-c3)` under `build`.
 * The rest is still there for screen readers.
 */
function JobName({ name, matrix }: { name: string; matrix: string | undefined }) {
  const prefix = `${matrix} (`;
  if (matrix === undefined || !name.startsWith(prefix) || !name.endsWith(")")) {
    return <>{name}</>;
  }
  return (
    <>
      <span class="visually-hidden">{prefix}</span>
      {name.slice(prefix.length, -1)}
      <span class="visually-hidden">)</span>
    </>
  );
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
  selected,
  onSelect,
  card,
  compact = false,
  matrix,
}: {
  job: Job;
  now: number;
  run: ReleaseRun;
  selected: boolean;
  onSelect: (job: Job) => void;
  /** Its key on the graph, for the lines to find it. */
  card?: string;
  /** In a matrix's grid: one line, even while it runs. */
  compact?: boolean;
  /** In a matrix's grid: the matrix's name, which goes without saying there. */
  matrix?: string | undefined;
}) {
  const tone = toneOf(job.state);
  const time = jobTime(job, now);
  const live = isLive(job.state);
  const look = live ? " job-live" : isTick(job.state) ? " job-tick" : "";
  const text = <JobName name={job.name} matrix={matrix} />;
  const detailsId = jobDetailsId(run, job);
  return (
    <li class={`job tone-${tone}${look}`} title={labelOf(job.state)} {...(card ? { "data-card": card } : {})}>
      <button
        type="button"
        class="job-inspect"
        aria-label={`Inspect ${job.name}`}
        aria-expanded={selected}
        aria-controls={detailsId}
        onClick={() => onSelect(job)}
      >
        <ToneIcon tone={tone} />
        {live && !compact ? (
          // The step to look at says what it is doing in words, not only in its colour.
          <span class="job-text">
            <span>{text}</span>
            <span class="job-state">
              <span class="visually-hidden">: </span>
              {labelOf(job.state)}
              {time && ` · ${time}`}
            </span>
          </span>
        ) : (
          <>
            <span>{text}</span>
            {/* The chip's colour and shape, in words, for who can't see them. */}
            <span class="visually-hidden">: {labelOf(job.state)}</span>
            {time && <span class="job-time">{time}</span>}
          </>
        )}
      </button>
    </li>
  );
}

function jobDetailsId(run: ReleaseRun, job: Job): string {
  return `job-details-${run.repo.replace(/[^a-z0-9]+/gi, "-")}-${run.id}-${job.id}`;
}

function JobDetails({
  job,
  run,
  now,
  rerun,
  onNotice,
  onClose,
}: {
  job: Job;
  run: ReleaseRun;
  now: number;
  rerun: RunActions | undefined;
  onNotice: (notice: Notice | undefined) => void;
  onClose: () => void;
}) {
  const time = jobTime(job, now);
  return (
    <section id={jobDetailsId(run, job)} class="job-inspector" aria-label={`Job details: ${job.name}`}>
      <div class="job-inspector-head">
        <h3>{job.name}</h3>
        <button type="button" class="secondary" aria-label={`Close details for ${job.name}`} onClick={onClose}>
          Close
        </button>
      </div>
      <dl class="job-inspector-facts">
        <div>
          <dt>Status</dt>
          <dd>{labelOf(job.state)}</dd>
        </div>
        {job.startedAt && (
          <div>
            <dt>Started</dt>
            <dd>
              <time dateTime={job.startedAt}>{new Date(job.startedAt).toLocaleString()}</time>
            </dd>
          </div>
        )}
        {time && (
          <div>
            <dt>Duration</dt>
            <dd>{time}</dd>
          </div>
        )}
      </dl>
      <div class="job-inspector-actions">
        {job.url && <ExternalLink href={job.url}>Open logs for {job.name} on GitHub</ExternalLink>}
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
      </div>
    </section>
  );
}
