import { useState } from "preact/hooks";
import type { Project, PullRequest, ReleaseRun } from "../model.ts";
import { summarize } from "../model.ts";
import { ExternalLink } from "./ExternalLink.tsx";
import { ProjectActions } from "./ProjectList.tsx";
import { PullList } from "./PullList.tsx";
import { ReleaseList } from "./ReleaseList.tsx";
import { useActions } from "./actions.tsx";
import "./Workspace.css";

type Scope = "all" | string;

export function Workspace({ projects, pulls, runs, now }: {
  projects: Project[];
  pulls: PullRequest[];
  runs: ReleaseRun[];
  now: number;
}) {
  const [scope, setScope] = useState<Scope>("all");
  const [tab, setTab] = useState<"all" | "pulls" | "workflows">("all");
  const [filter, setFilter] = useState("");
  const selected = projects.find((project) => project.repo === scope);
  const visiblePulls = selected ? pulls.filter((pull) => pull.repo === selected.repo) : pulls;
  const visibleRuns = selected ? runs.filter((run) => run.repo === selected.repo) : runs;
  const active = (run: ReleaseRun) => ["running", "waiting", "queued"].includes(run.state) && !run.finishedAt;
  const running = visibleRuns.filter(active);
  const attention = visiblePulls.filter((pull) => summarize(pull.checks) === "failed" || pull.mergeState === "conflicts");
  const actions = useActions()?.runs;
  const listed = [...projects].sort((a, b) => a.name.localeCompare(b.name)).filter((project) =>
    project.name.toLowerCase().includes(filter.toLowerCase()) || project.repo.toLowerCase().includes(filter.toLowerCase())
  );

  return (
    <div class="workspace">
      <aside class="workspace-sidebar" aria-label="Repository navigation">
        <div class="workspace-sidebar-label">WORKSPACE</div>
        <button type="button" class={scope === "all" ? "workspace-nav active" : "workspace-nav"}
          aria-current={scope === "all" ? "page" : undefined}
          onClick={() => { setScope("all"); setTab("all"); }}>
          <span>◈ &nbsp; Overview</span><span class="workspace-nav-count">{projects.length}</span>
        </button>
        <div class="workspace-sidebar-label workspace-repo-label">REPOSITORIES</div>
        <input class="workspace-search" type="search" placeholder="Filter repositories…" aria-label="Filter repositories"
          value={filter} onInput={(event) => setFilter(event.currentTarget.value)} />
        <nav class="workspace-repos" aria-label="Repositories">
          {listed.map((project) => {
            const count = pulls.filter((pull) => pull.repo === project.repo).length;
            const busy = runs.some((run) => run.repo === project.repo && active(run));
            return (
              <button key={project.repo} type="button" class={scope === project.repo ? "workspace-nav active" : "workspace-nav"}
                aria-current={scope === project.repo ? "page" : undefined}
                onClick={() => { setScope(project.repo); setTab("all"); }}>
                <span class="workspace-repo-name"><span class={busy ? "workspace-status busy" : "workspace-status"} aria-hidden="true" />{project.name}</span>
                {count > 0 && <span class="workspace-nav-count">{count}</span>}
              </button>
            );
          })}
          {listed.length === 0 && <p class="quiet workspace-no-repos">No matching repositories</p>}
        </nav>
      </aside>
      <div class="workspace-main">
        <div class="workspace-intro">
          <div>
            <div class="workspace-eyebrow">{selected ? "REPOSITORY WORKSPACE" : "COMMAND CENTER"}</div>
            <h2>{selected ? selected.name : "Overview"}</h2>
            <p class="quiet">{selected ? selected.repo : "Pull requests, deployments, and releases across your repositories."}</p>
          </div>
          {selected && <div class="workspace-intro-actions">
            <ExternalLink href={selected.url}>View on GitHub</ExternalLink>
            {actions && <ProjectActions project={selected} actions={actions} />}
          </div>}
        </div>
        <div class="workspace-metrics" aria-label="Dashboard summary">
          <div class="workspace-metric"><span>OPEN PULL REQUESTS</span><strong>{visiblePulls.length}</strong><small>Across selected repositories</small></div>
          <div class="workspace-metric"><span>ACTIVE WORKFLOWS</span><strong>{running.length}</strong><small>Running or awaiting approval</small></div>
          <div class="workspace-metric"><span>NEEDS ATTENTION</span><strong class={attention.length ? "workspace-alert-number" : ""}>{attention.length}</strong><small>Failed checks or conflicts</small></div>
          <div class="workspace-metric"><span>REPOSITORIES</span><strong>{selected ? 1 : projects.length}</strong><small>{selected ? "Selected repository" : "In your workspace"}</small></div>
        </div>
        <div class="workspace-tabs" role="group" aria-label="Content filter">
          {(["all", "pulls", "workflows"] as const).map((value) => (
            <button key={value} type="button" aria-pressed={tab === value} onClick={() => setTab(value)}>
              {value === "all" ? "Workspace" : value === "pulls" ? "Pull requests" : "Workflows"}
            </button>
          ))}
        </div>
        <div class={tab === "all" ? "workspace-content" : "workspace-content workspace-content-focused"}>
          {tab !== "workflows" && <PullList pulls={visiblePulls} now={now} />}
          {tab !== "pulls" && <ReleaseList runs={visibleRuns} now={now} />}
          {tab === "all" && !selected && <section class="workspace-release-panel">
            <h3>Quick releases</h3>
            <p class="quiet">Select a repository to inspect its workflows and release a new version.</p>
            <div class="workspace-quick-repos">
              {projects.map((project) => (
                <button key={project.repo} type="button" onClick={() => { setScope(project.repo); setTab("all"); }}>
                  {project.name}<span aria-hidden="true">→</span>
                </button>
              ))}
            </div>
          </section>}
        </div>
      </div>
    </div>
  );
}
