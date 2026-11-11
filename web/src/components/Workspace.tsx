import { useState } from "preact/hooks";
import type { Project, PullRequest, ReleaseRun } from "../model.ts";
import { summarize } from "../model.ts";
import { useActions } from "./actions.tsx";
import { ExternalLink } from "./ExternalLink.tsx";
import { ProjectActions, ProjectList } from "./ProjectList.tsx";
import { PullList } from "./PullList.tsx";
import { ReleaseList, shownRuns } from "./ReleaseList.tsx";
import "./Workspace.css";

type Scope = string | undefined;

export function Workspace({
  projects,
  pulls,
  runs,
  now,
  hidden,
  onToggle,
}: {
  projects: Project[];
  pulls: PullRequest[];
  runs: ReleaseRun[];
  now: number;
  hidden: ReadonlySet<string>;
  onToggle: (repo: string) => void;
}) {
  const [scope, setScope] = useState<Scope>(undefined);
  const [tab, setTab] = useState<"all" | "pulls" | "workflows">("all");
  const [filter, setFilter] = useState("");
  const shown = projects.filter((project) => !hidden.has(project.repo));
  const selected = shown.find((project) => project.repo === scope);
  const currentScope = selected?.repo;
  const visiblePulls = selected ? pulls.filter((pull) => pull.repo === selected.repo) : pulls;
  const visibleRuns = shownRuns(selected ? runs.filter((run) => run.repo === selected.repo) : runs, now);
  const active = (run: ReleaseRun) => ["running", "waiting", "queued"].includes(run.state) && !run.finishedAt;
  const running = visibleRuns.filter(active);
  const attention = visiblePulls.filter(
    (pull) => summarize(pull.checks) === "failed" || pull.mergeState === "conflicts",
  );
  const waiting = visibleRuns.filter((run) => run.state === "waiting" || run.approvals.length > 0);
  const failed = visibleRuns.filter((run) => run.state === "failed" || run.state === "cancelled");
  const attentionCount = attention.length + waiting.length + failed.length;
  const actions = useActions()?.runs;
  const listed = [...shown]
    .sort((a, b) => a.name.localeCompare(b.name))
    .filter(
      (project) =>
        project.name.toLowerCase().includes(filter.toLowerCase()) ||
        project.repo.toLowerCase().includes(filter.toLowerCase()),
    );

  return (
    <div class="workspace">
      <aside class="workspace-sidebar" aria-label="Repository navigation">
        <div class="workspace-sidebar-label">WORKSPACE</div>
        <button
          type="button"
          class={currentScope === undefined ? "workspace-nav active" : "workspace-nav"}
          aria-current={currentScope === undefined ? "page" : undefined}
          onClick={() => {
            setScope(undefined);
            setTab("all");
          }}
        >
          <span>◈ &nbsp; Overview</span>
          <span class="workspace-nav-count">{shown.length}</span>
        </button>
        <div class="workspace-sidebar-label workspace-repo-label">REPOSITORIES</div>
        <input
          class="workspace-search"
          type="search"
          placeholder="Filter repositories…"
          aria-label="Filter repositories"
          value={filter}
          onInput={(event) => setFilter(event.currentTarget.value)}
        />
        <nav class="workspace-repos" aria-label="Repositories">
          {listed.map((project) => {
            const count = pulls.filter((pull) => pull.repo === project.repo).length;
            const busy = runs.some((run) => run.repo === project.repo && active(run));
            return (
              <button
                key={project.repo}
                type="button"
                class={currentScope === project.repo ? "workspace-nav active" : "workspace-nav"}
                aria-current={currentScope === project.repo ? "page" : undefined}
                onClick={() => {
                  setScope(project.repo);
                  setTab("all");
                }}
              >
                <span class="workspace-repo-name">
                  <span class={busy ? "workspace-status busy" : "workspace-status"} aria-hidden="true" />
                  {project.name}
                </span>
                {busy && <span class="visually-hidden">Active workflow</span>}
                {count > 0 && <span class="workspace-nav-count">{count}</span>}
              </button>
            );
          })}
          {listed.length === 0 && <p class="quiet workspace-no-repos">No matching repositories</p>}
        </nav>
        <details class="workspace-manage">
          <summary>Manage repositories</summary>
          <ul>
            {projects.map((project) => (
              <li key={project.repo}>
                <span title={project.repo}>{project.name}</span>
                <button
                  type="button"
                  aria-label={`${hidden.has(project.repo) ? "Show" : "Hide"} ${project.name}`}
                  onClick={() => onToggle(project.repo)}
                >
                  {hidden.has(project.repo) ? "Show" : "Hide"}
                </button>
              </li>
            ))}
          </ul>
          {projects.length === 0 && <p class="quiet">No repositories</p>}
        </details>
      </aside>
      <div class="workspace-main">
        <div class="workspace-intro">
          <div>
            <div class="workspace-eyebrow">{selected ? "REPOSITORY WORKSPACE" : "COMMAND CENTER"}</div>
            <h2>{selected ? selected.name : "Overview"}</h2>
            <p class="quiet">
              {selected ? selected.repo : "Pull requests, deployments, and releases across your repositories."}
            </p>
          </div>
          {selected && (
            <div class="workspace-intro-actions">
              <ExternalLink href={selected.url}>View on GitHub</ExternalLink>
              {actions && <ProjectActions project={selected} actions={actions} />}
            </div>
          )}
        </div>
        <section class="workspace-metrics" aria-label="Dashboard summary">
          <div class="workspace-metric">
            <span>OPEN PULL REQUESTS</span>
            <strong>{visiblePulls.length}</strong>
            <small>{selected ? "In this repository" : "Across visible repositories"}</small>
          </div>
          <div class="workspace-metric">
            <span>ACTIVE WORKFLOWS</span>
            <strong>{running.length}</strong>
            <small>Running or awaiting approval</small>
          </div>
          <div class="workspace-metric">
            <span>NEEDS ATTENTION</span>
            <strong class={attentionCount ? "workspace-alert-number" : ""}>{attentionCount}</strong>
            <small>Failed PRs, workflows or approvals</small>
          </div>
          <div class="workspace-metric">
            <span>REPOSITORIES</span>
            <strong>{selected ? 1 : shown.length}</strong>
            <small>{selected ? "Selected repository" : "In your workspace"}</small>
          </div>
        </section>
        <fieldset class="workspace-tabs" aria-label="Content filter">
          {(["all", "pulls", "workflows"] as const).map((value) => (
            <button key={value} type="button" aria-pressed={tab === value} onClick={() => setTab(value)}>
              {value === "all" ? "Workspace" : value === "pulls" ? "Pull requests" : "Workflows"}
            </button>
          ))}
        </fieldset>
        <div class={tab === "all" ? "workspace-content" : "workspace-content workspace-content-focused"}>
          {tab !== "workflows" && <PullList pulls={visiblePulls} now={now} />}
          {tab !== "pulls" && (
            <div class="workspace-workflows">
              <p class="workspace-eyebrow">WORKFLOW MISSION CONTROL</p>
              <ReleaseList runs={visibleRuns} now={now} inspect />
            </div>
          )}
          {tab === "all" && !selected && (
            <details class="workspace-release-panel">
              <summary>Releases &amp; promotion</summary>
              <ProjectList projects={shown} now={now} />
            </details>
          )}
        </div>
      </div>
    </div>
  );
}
