import type { CheckState, Job, ReleaseRun } from "../model.ts";
import { Ago } from "./Ago.tsx";
import { shortName } from "./PullList.tsx";
import { Legend, labelOf, StateChip, ToneIcon, toneOf } from "./state.tsx";
import { duration } from "./time.ts";

const ACTIVE: CheckState[] = ["running", "waiting", "queued"];

/** Runs still going first, then the newest. */
export function sortRuns(runs: ReleaseRun[]): ReleaseRun[] {
  const active = (run: ReleaseRun) => (ACTIVE.includes(run.state) ? 0 : 1);
  return [...runs].sort(
    (a, b) => active(a) - active(b) || Date.parse(b.startedAt) - Date.parse(a.startedAt) || b.id - a.id,
  );
}

/** The release workflows' runs, one card per row: a run gets the panel's whole width, never half of it. */
export function ReleaseList({ runs, now }: { runs: ReleaseRun[]; now: number }) {
  return (
    <section class="panel" aria-labelledby="releases-heading">
      <div class="panel-heading">
        <h2 id="releases-heading">
          Release workflows <span class="count">{runs.length}</span>
        </h2>
      </div>
      <Legend />
      {runs.length === 0 ? (
        <p class="empty">No release runs</p>
      ) : (
        <ul class="rows">
          {sortRuns(runs).map((run) => (
            <ReleaseCard key={`${run.repo}:${run.id}`} run={run} now={now} />
          ))}
        </ul>
      )}
    </section>
  );
}

function ReleaseCard({ run, now }: { run: ReleaseRun; now: number }) {
  const started = Date.parse(run.startedAt);
  return (
    <li class="release">
      <div class="release-top">
        <span class="repo-label" title={run.repo}>
          {shortName(run.repo)} <span aria-hidden="true">·</span> {run.workflow}
        </span>
        <StateChip state={run.state} />
      </div>
      <a class="release-title" href={run.url}>
        {run.title}
      </a>
      <p class="meta">
        {run.actor && <span>started by {run.actor}</span>}
        <span>
          <Ago at={run.startedAt} now={now} />
        </span>
        <span>
          {run.finishedAt
            ? `took ${duration(Date.parse(run.finishedAt) - started)}`
            : `going for ${duration(now - started)}`}
        </span>
      </p>
      {run.jobs.length > 0 && (
        <ul class="jobs" aria-label="Jobs">
          {run.jobs.map((job) => (
            <JobChip key={job.id} job={job} now={now} />
          ))}
        </ul>
      )}
    </li>
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

function JobChip({ job, now }: { job: Job; now: number }) {
  const tone = toneOf(job.state);
  const time = jobTime(job, now);
  return (
    <li class={`job tone-${tone}`} title={labelOf(job.state)}>
      <ToneIcon tone={tone} />
      {job.url ? <a href={job.url}>{job.name}</a> : <span>{job.name}</span>}
      {/* The chip's colour and shape, in words, for who can't see them. */}
      <span class="visually-hidden">: {labelOf(job.state)}</span>
      {time && <span class="job-time">{time}</span>}
    </li>
  );
}
