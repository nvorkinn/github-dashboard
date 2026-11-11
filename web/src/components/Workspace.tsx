import { useState } from "preact/hooks";
import type { Project, PullRequest, ReleaseRun } from "../model.ts";
import { summarize } from "../model.ts";
import { useActions } from "./actions.tsx";
import { ExternalLink } from "./ExternalLink.tsx";
import { ProjectActions, ProjectList } from "./ProjectList.tsx";
import { columnOf, PullList } from "./PullList.tsx";
import { ReleaseList, shownRuns } from "./ReleaseList.tsx";
import "./Workspace.css";

type Scope = string | undefined;
type WorkspaceTab = "all" | "pulls" | "workflows" | "releases" | "attention";

const ACTIVE_RUNS = new Set(["running", "waiting", "queued"]);

function active(run: ReleaseRun): boolean {
  return ACTIVE_RUNS.has(run.state) && !run.finishedAt;
}

function pullNeedsAttention(pull: PullRequest): boolean {
  const checks = summarize(pull.checks);
  return checks === "failed" || pull.mergeState === "conflicts" || pull.mergeState === "behind";
}

function runNeedsAttention(run: ReleaseRun): boolean {
  return run.state === "failed" || run.state === "cancelled" || run.state === "waiting" || run.approvals.length > 0;
}

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
  const [tab, setTab] = useState<WorkspaceTab>("all");
  const [filter, setFilter] = useState("");
  const shown = projects.filter((project) => !hidden.has(project.repo));
  const selected = shown.find((project) => project.repo === scope);
  const currentScope = selected?.repo;
  const visiblePulls = selected ? pulls.filter((pull) => pull.repo === selected.repo) : pulls;
  const visibleRuns = shownRuns(selected ? runs.filter((run) => run.repo === selected.repo) : runs, now);
  const running = visibleRuns.filter(active);
  const attentionPulls = visiblePulls.filter(pullNeedsAttention);
  const attentionRuns = visibleRuns.filter(runNeedsAttention);
  const attentionCount = attentionPulls.length + attentionRuns.length;
  const ready = visiblePulls.filter((pull) => columnOf(pull) === "ready");
  const actions = useActions()?.runs;
  const listed = [...shown]
    .sort((a, b) => a.name.localeCompare(b.name))
    .filter(
      (project) =>
        project.name.toLowerCase().includes(filter.toLowerCase()) ||
        project.repo.toLowerCase().includes(filter.toLowerCase()),
    );
  const tabs: { value: WorkspaceTab; label: string; count?: number }[] = [
    { value: "all", label: "Overview" },
    { value: "pulls", label: "Pull requests", count: visiblePulls.length },
    { value: "workflows", label: "Workflows", count: running.length },
    {
      value: "releases",
      label: "Releases",
      count: (selected ? [selected] : shown).filter((one) => one.latestRelease).length,
    },
    { value: "attention", label: "Needs attention", count: attentionCount },
  ];

  return (
    <div class="workspace">
      <aside class="workspace-sidebar" aria-label="Repository navigation">
        <div class="workspace-sidebar-head">
          <h2>Repositories</h2>
          <span>{shown.length}</span>
        </div>
        <button
          type="button"
          class={
            currentScope === undefined ? "workspace-nav workspace-overview active" : "workspace-nav workspace-overview"
          }
          aria-current={currentScope === undefined ? "page" : undefined}
          onClick={() => {
            setScope(undefined);
            setTab("all");
          }}
        >
          <span class="workspace-nav-icon" aria-hidden="true">
            ⌂
          </span>
          <span>Overview</span>
          <span class="workspace-nav-count">{shown.length}</span>
        </button>
        <label class="workspace-search-wrap">
          <span class="visually-hidden">Filter repositories</span>
          <span aria-hidden="true">⌕</span>
          <input
            class="workspace-search"
            type="search"
            placeholder="Filter repositories…"
            aria-label="Filter repositories"
            value={filter}
            onInput={(event) => setFilter(event.currentTarget.value)}
          />
        </label>
        <div class="workspace-sidebar-label">VISIBLE REPOSITORIES</div>
        <nav class="workspace-repos" aria-label="Repositories">
          {listed.map((project) => {
            const count = pulls.filter((pull) => pull.repo === project.repo).length;
            const busy = runs.some((run) => run.repo === project.repo && active(run));
            const problem =
              pulls.some((pull) => pull.repo === project.repo && pullNeedsAttention(pull)) ||
              runs.some((run) => run.repo === project.repo && runNeedsAttention(run));
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
                  <span
                    class={problem ? "workspace-status problem" : busy ? "workspace-status busy" : "workspace-status"}
                    aria-hidden="true"
                  />
                  {project.name}
                </span>
                {busy && <span class="visually-hidden">Active workflow</span>}
                {problem && <span class="visually-hidden">Needs attention</span>}
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
        <nav class="workspace-tabs" aria-label="Workspace sections">
          {tabs.map((one) => (
            <button
              key={one.value}
              type="button"
              aria-label={one.label}
              aria-pressed={tab === one.value}
              onClick={() => setTab(one.value)}
            >
              <span class="workspace-tab-icon" aria-hidden="true">
                {one.value === "all"
                  ? "⌂"
                  : one.value === "pulls"
                    ? "⌁"
                    : one.value === "workflows"
                      ? "▶"
                      : one.value === "releases"
                        ? "◇"
                        : "△"}
              </span>
              {one.label}
              {one.count !== undefined && <span class="count">{one.count}</span>}
            </button>
          ))}
        </nav>

        <header class="workspace-intro">
          <div class="workspace-repo-mark" aria-hidden="true">
            {selected ? selected.name.slice(0, 1).toUpperCase() : "⌘"}
          </div>
          <div class="workspace-intro-copy">
            <p class="workspace-breadcrumb">
              Repositories <span aria-hidden="true">›</span> {selected?.name ?? "Overview"}
            </p>
            <div class="workspace-title-line">
              <h2>{selected ? selected.name : "Overview"}</h2>
              {selected && <span class="badge">{selected.private ? "Private" : "Public"}</span>}
              {selected?.latestRelease && <span class="badge badge-accent">{selected.latestRelease.tag}</span>}
            </div>
            <p class="quiet">
              {selected
                ? `Pull requests, workflows and releases for ${selected.repo}`
                : "Operational status across every visible repository."}
            </p>
          </div>
          {selected && (
            <div class="workspace-intro-actions">
              <ExternalLink href={selected.url}>Open on GitHub</ExternalLink>
              {actions && <ProjectActions project={selected} actions={actions} />}
            </div>
          )}
        </header>

        <section class="workspace-metrics" aria-label="Dashboard summary">
          <div class="workspace-metric metric-pulls">
            <span class="workspace-metric-icon" aria-hidden="true">
              ⌁
            </span>
            <span>OPEN PULL REQUESTS</span>
            <strong>{visiblePulls.length}</strong>
            <small>{selected ? "In this repository" : "Across visible repositories"}</small>
          </div>
          <div class="workspace-metric metric-running">
            <span class="workspace-metric-icon" aria-hidden="true">
              ▶
            </span>
            <span>ACTIVE WORKFLOWS</span>
            <strong>{running.length}</strong>
            <small>Running or awaiting approval</small>
          </div>
          <div class="workspace-metric metric-ready">
            <span class="workspace-metric-icon" aria-hidden="true">
              ✓
            </span>
            <span>READY TO MERGE</span>
            <strong>{ready.length}</strong>
            <small>Checks passed and mergeable</small>
          </div>
          <div class="workspace-metric metric-attention">
            <span class="workspace-metric-icon" aria-hidden="true">
              !
            </span>
            <span>NEEDS ATTENTION</span>
            <strong class={attentionCount ? "workspace-alert-number" : ""}>{attentionCount}</strong>
            <small>Failed, conflicted or waiting</small>
          </div>
        </section>

        <div class={tab === "all" ? "workspace-content" : "workspace-content workspace-content-focused"}>
          {tab === "all" && (
            <>
              <PullList pulls={visiblePulls} now={now} compact />
              <div class="workspace-operations">
                <ReleaseList runs={visibleRuns} now={now} inspect />
                <ReleasePanel projects={selected ? [selected] : shown} now={now} />
              </div>
            </>
          )}
          {tab === "pulls" && <PullList pulls={visiblePulls} now={now} compact />}
          {tab === "workflows" && <ReleaseList runs={visibleRuns} now={now} inspect />}
          {tab === "releases" && <ReleasePanel projects={selected ? [selected] : shown} now={now} />}
          {tab === "attention" && (
            <div class="workspace-attention-view">
              <PullList pulls={attentionPulls} now={now} compact />
              <ReleaseList runs={attentionRuns} now={now} inspect />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function ReleasePanel({ projects, now }: { projects: Project[]; now: number }) {
  return (
    <section class="workspace-release-panel" aria-label="Releases and promotion">
      <p class="workspace-section-kicker">RELEASE CONTROL</p>
      <ProjectList projects={projects} now={now} />
    </section>
  );
}
