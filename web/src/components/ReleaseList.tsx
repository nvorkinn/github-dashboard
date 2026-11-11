import { useState } from "preact/hooks";
import type { Approval, CheckState, ReleaseRun, RunActions } from "../model.ts";
import { Ago } from "./Ago.tsx";
import { useActions } from "./actions.tsx";
import { ExternalLink } from "./ExternalLink.tsx";
import { Jobs } from "./Jobs.tsx";
import { shortName } from "./PullList.tsx";
import { type Notice, RunAction } from "./RunAction.tsx";
import { StateChip } from "./state.tsx";
import { countdown, duration } from "./time.ts";

const ACTIVE: CheckState[] = ["running", "waiting", "queued"];
// What a job or run ends in when GitHub's re-run of the failed jobs runs it again.
const RERUNNABLE: CheckState[] = ["failed", "cancelled"];

/** How long a run that finished stays on the page, folded, before it leaves. */
export const KEEP_FINISHED_MS = 5 * 60_000;

/** When a run ended, for one that is over; undefined while it goes on. */
function endOf(run: ReleaseRun): number | undefined {
  return run.finishedAt !== undefined && !ACTIVE.includes(run.state) ? Date.parse(run.finishedAt) : undefined;
}

/** The runs the page shows: those still going, and for five minutes those that just finished. */
export function shownRuns(runs: ReleaseRun[], now: number): ReleaseRun[] {
  return runs.filter((run) => {
    const end = endOf(run);
    return end === undefined || now - end < KEEP_FINISHED_MS;
  });
}

/** Runs still going first, then the newest. */
export function sortRuns(runs: ReleaseRun[]): ReleaseRun[] {
  const active = (run: ReleaseRun) => (ACTIVE.includes(run.state) ? 0 : 1);
  return [...runs].sort(
    (a, b) => active(a) - active(b) || Date.parse(b.startedAt) - Date.parse(a.startedAt) || b.id - a.id,
  );
}

/**
 * The release workflows' runs that are going, one card per row, and under them the ones that just finished, each
 * folded to a few lines until it leaves.
 */
export function ReleaseList({ runs, now, inspect = false }: { runs: ReleaseRun[]; now: number; inspect?: boolean }) {
  const shown = sortRuns(shownRuns(runs, now));
  return (
    <section class="panel" aria-labelledby="releases-heading">
      <div class="panel-heading">
        <h2 id="releases-heading">
          {inspect ? "Workflow activity" : "Running now"} <span class="count">{shown.length}</span>
        </h2>
      </div>
      {shown.length === 0 ? (
        <p class="empty">Nothing running</p>
      ) : (
        <ul class="rows">
          {shown.map((run) => (
            <ReleaseCard key={`${run.repo}:${run.id}`} run={run} now={now} inspect={inspect} />
          ))}
        </ul>
      )}
    </section>
  );
}

export function ReleaseCard({ run, now, inspect = false }: { run: ReleaseRun; now: number; inspect?: boolean }) {
  const actions = useActions()?.runs;
  // What a job's re-run came to: said under the jobs, as a chip has no room for it.
  const [jobNotice, setJobNotice] = useState<Notice | undefined>(undefined);
  const started = Date.parse(run.startedAt);
  // GitHub re-runs jobs only of a run that has finished.
  const end = endOf(run);
  const finished = end !== undefined;
  const rerunFailed = finished && RERUNNABLE.includes(run.state) ? actions : undefined;
  const waiting = run.finishedAt === undefined ? run.approvals : [];
  const jobs = (
    <Jobs
      run={run}
      now={now}
      rerunOf={(job) => (finished && RERUNNABLE.includes(job.state) ? actions : undefined)}
      onNotice={setJobNotice}
    />
  );
  return (
    <li class={finished ? "release release-folded" : "release"}>
      <div class="release-top">
        <span class="repo-label" title={run.repo}>
          {shortName(run.repo)} <span aria-hidden="true">·</span> {run.workflow}
        </span>
        <span class="release-badges">
          {run.tag && (
            <span class="badge release-tag" title={`Releasing ${run.tag}`}>
              {run.tag}
            </span>
          )}
          <StateChip state={run.state} />
        </span>
      </div>
      <ExternalLink class="release-title" href={run.url}>
        {run.title}
      </ExternalLink>
      {end === undefined ? (
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
      ) : (
        <Leaving end={end} took={end - started} now={now} />
      )}
      {end === undefined
        ? jobs
        : run.jobs.length > 0 && (
            <details class="folded-jobs">
              <summary aria-label={`Jobs for ${run.title}`}>Jobs</summary>
              {jobs}
            </details>
          )}
      {inspect && (
        <details class="workspace-job-details">
          <summary aria-label={`Job details and logs for ${run.title}`}>Job details &amp; logs</summary>
          <p class="quiet">Logs open on GitHub with your repository permissions.</p>
          {run.jobs.length === 0 ? (
            <p class="empty">No job details available.</p>
          ) : (
            <ul class="workspace-job-list">
              {run.jobs.map((job) => (
                <li key={job.id}>
                  <span>{job.name}</span>
                  <StateChip state={job.state} />
                  {job.url && (
                    <ExternalLink href={job.url}>
                      Logs on GitHub<span class="visually-hidden"> for {job.name}</span>
                    </ExternalLink>
                  )}
                </li>
              ))}
            </ul>
          )}
        </details>
      )}
      {jobNotice && (
        <p class={jobNotice.failed ? "action-problem" : "action-done"} role={jobNotice.failed ? "alert" : "status"}>
          {jobNotice.text}
        </p>
      )}
      {(waiting.length > 0 || rerunFailed) && (
        <div class="actions">
          {waiting.map((one) => (
            <ApprovalActions key={one.environmentId} run={run} approval={one} actions={actions} />
          ))}
          {rerunFailed && (
            <RunAction
              label="Re-run failed jobs"
              title="Re-run this run's failed and cancelled jobs, and the jobs that need them"
              busy="Starting…"
              run={async () => {
                await rerunFailed.rerunFailed(run);
                return "Re-run of the failed jobs started.";
              }}
            />
          )}
        </div>
      )}
    </li>
  );
}

/** A finished run's last line: how long it took, and how long until it leaves the page, also as a bar that empties. */
function Leaving({ end, took, now }: { end: number; took: number; now: number }) {
  const left = Math.max(0, KEEP_FINISHED_MS - (now - end));
  return (
    <>
      <p class="meta">
        <span>took {duration(took)}</span>
        <span class="leaves">leaves in {countdown(left)}</span>
      </p>
      <progress class="leaves-bar" max={KEEP_FINISHED_MS} value={left} aria-hidden="true" />
    </>
  );
}

/**
 * Approve and Reject for one environment the run waits for, each asking first: a deploy that goes ahead can't be
 * taken back. Only for a required reviewer; anyone else is told who it waits for.
 */
function ApprovalActions({
  run,
  approval,
  actions,
}: {
  run: ReleaseRun;
  approval: Approval;
  actions: RunActions | undefined;
}) {
  const { environment } = approval;
  if (!approval.canApprove || !actions) {
    return <span class="quiet action-note">{environment} waits for its required reviewers</span>;
  }
  return (
    <span class="approval">
      <RunAction
        label={`Approve ${environment}`}
        title={`Let the run deploy to ${environment}`}
        busy="Approving…"
        ask={() => `Approve ${environment}?`}
        run={async () => {
          await actions.review(run, approval, "approved");
          return `Approved ${environment}.`;
        }}
      />
      <RunAction
        label="Reject"
        name={`Reject ${environment}`}
        title={`Stop the run from deploying to ${environment}`}
        busy="Rejecting…"
        secondary
        ask={() => `Reject ${environment}?`}
        run={async () => {
          await actions.review(run, approval, "rejected");
          return `Rejected ${environment}.`;
        }}
      />
    </span>
  );
}
