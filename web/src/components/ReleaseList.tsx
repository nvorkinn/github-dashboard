import { useState } from "preact/hooks";
import type { Approval, CheckState, ReleaseRun, RunActions } from "../model.ts";
import { Ago } from "./Ago.tsx";
import { useActions } from "./actions.tsx";
import { Jobs } from "./Jobs.tsx";
import { shortName } from "./PullList.tsx";
import { type Notice, RunAction } from "./RunAction.tsx";
import { Legend, StateChip } from "./state.tsx";
import { duration } from "./time.ts";

const ACTIVE: CheckState[] = ["running", "waiting", "queued"];
// What a job or run ends in when GitHub's re-run of the failed jobs runs it again.
const RERUNNABLE: CheckState[] = ["failed", "cancelled"];

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
  const actions = useActions()?.runs;
  // What a job's re-run came to: said under the jobs, as a chip has no room for it.
  const [jobNotice, setJobNotice] = useState<Notice | undefined>(undefined);
  const started = Date.parse(run.startedAt);
  // GitHub re-runs jobs only of a run that has finished.
  const finished = run.finishedAt !== undefined && !ACTIVE.includes(run.state);
  const rerunFailed = finished && RERUNNABLE.includes(run.state) ? actions : undefined;
  const waiting = run.finishedAt === undefined ? run.approvals : [];
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
      <Jobs
        run={run}
        now={now}
        rerunOf={(job) => (finished && RERUNNABLE.includes(job.state) ? actions : undefined)}
        onNotice={setJobNotice}
      />
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
