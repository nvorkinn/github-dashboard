import type { DashboardData, Job, JobGraph, JobNode, ReleaseRun } from "../model.ts";

/** One job of a sample workflow file: its id, the jobs it needs, and whether it runs as a matrix. */
type Spec = { key: string; needs?: string[]; matrix?: boolean };

/**
 * The sample workflows' files, by repository name and workflow, as the real dashboard reads them from GitHub. Each
 * shows the graph in another shape: a pipeline that runs across, a big matrix that runs top to bottom, and chains
 * that turn into a timeline when the card is narrow.
 */
const FILES: Record<string, Spec[]> = {
  "weather-station/Release": [
    { key: "version" },
    { key: "build", needs: ["version"], matrix: true },
    { key: "smoke test", needs: ["build"] },
    { key: "deploy dev", needs: ["smoke test"] },
    { key: "approve-prod", needs: ["deploy dev"] },
    { key: "deploy prod", needs: ["approve-prod"] },
    { key: "publish release", needs: ["deploy prod"] },
    { key: "notify", needs: ["publish release"] },
  ],
  "garden-sensors/Release firmware": [
    { key: "version" },
    { key: "build", needs: ["version"], matrix: true },
    { key: "sign", needs: ["build"] },
    { key: "publish release", needs: ["sign"] },
  ],
  "home-ledger/Deploy": [
    { key: "build image" },
    { key: "migrate database", needs: ["build image"] },
    { key: "deploy", needs: ["migrate database"] },
    { key: "health check", needs: ["deploy"] },
  ],
  "home-ledger/Promote": [
    { key: "check tag" },
    { key: "approve-prod", needs: ["check tag"] },
    { key: "deploy prod", needs: ["approve-prod"] },
    { key: "health check", needs: ["deploy prod"] },
  ],
};

/** Gives each sample run the graph of its workflow's file, built from its jobs as they are now. */
export function withGraphs(data: DashboardData): DashboardData {
  return { ...data, releases: data.releases.map(withGraph) };
}

function withGraph(run: ReleaseRun): ReleaseRun {
  const specs = FILES[`${run.repo.split("/").pop()}/${run.workflow}`];
  return specs ? { ...run, graph: graphOf(specs, run.jobs) } : run;
}

function graphOf(specs: Spec[], jobs: Job[]): JobGraph {
  const placed = new Set<Job>();
  const nodes: JobNode[] = specs.map(({ key, needs = [], matrix = false }) => {
    const mine = jobs.filter((job) => (matrix ? job.name.startsWith(`${key} (`) : job.name === key));
    for (const job of mine) {
      placed.add(job);
    }
    return { key, name: key, needs, several: matrix, jobs: mine };
  });
  return { nodes, unplaced: jobs.filter((job) => !placed.has(job)) };
}
