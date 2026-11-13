import { useEffect, useState } from "preact/hooks";
import type { Project, PullRequest, ReleaseRun } from "../model.ts";
import { summarize } from "../model.ts";
import { useActions } from "./actions.tsx";
import { ExternalLink } from "./ExternalLink.tsx";
import { Icon, type IconName } from "./Icon.tsx";
import { ProjectActions, ProjectList } from "./ProjectList.tsx";
import { columnOf, PullList } from "./PullList.tsx";
import { ReleaseList, shownRuns, sortRuns } from "./ReleaseList.tsx";
import { RepositorySettings } from "./RepositorySettings.tsx";
import { Unreleased } from "./Unreleased.tsx";
import "./Workspace.css";

type Scope = string | undefined;
type WorkspaceTab = "all" | "pulls" | "ready" | "workflows" | "releases" | "attention" | "settings";
type VisibleTab = Exclude<WorkspaceTab, "ready">;

export type WorkspaceSection = "overview" | "pulls" | "workflows" | "releases" | "attention" | "settings";
export type WorkspaceDestination = {
  /** A visible owner/repository, `null` for the all-repository overview, or omitted to keep the current scope. */
  repo?: string | null;
  /** A section in the current scope. Selecting a repository always opens its overview first. */
  section?: WorkspaceSection;
};

export const WORKSPACE_NAVIGATE_EVENT = "github-dashboard:workspace-navigate";

/** Lets application-level controls, such as the command palette, navigate the mounted Workspace. */
export function navigateWorkspace(destination: WorkspaceDestination): void {
  window.dispatchEvent(new CustomEvent<WorkspaceDestination>(WORKSPACE_NAVIGATE_EVENT, { detail: destination }));
}

const TAB_ICONS: Record<VisibleTab, IconName> = {
  all: "overview",
  pulls: "pull-request",
  workflows: "workflow",
  releases: "release",
  attention: "attention",
  settings: "settings",
};

const ACTIVE_RUNS = new Set(["running", "waiting", "queued"]);
const SECTIONS: Record<WorkspaceSection, VisibleTab> = {
  overview: "all",
  pulls: "pulls",
  workflows: "workflows",
  releases: "releases",
  attention: "attention",
  settings: "settings",
};

function destinationOf(event: Event): WorkspaceDestination | undefined {
  const detail: unknown = (event as CustomEvent<unknown>).detail;
  if (typeof detail !== "object" || detail === null) {
    return undefined;
  }
  const { repo, section } = detail as Record<string, unknown>;
  if (repo !== undefined && repo !== null && typeof repo !== "string") {
    return undefined;
  }
  if (section !== undefined && (typeof section !== "string" || !(section in SECTIONS))) {
    return undefined;
  }
  const destination: WorkspaceDestination = {};
  if (repo !== undefined) {
    destination.repo = repo as string | null;
  }
  if (section !== undefined) {
    destination.section = section as WorkspaceSection;
  }
  return destination;
}

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
  const repositoryConfig = useActions()?.repositories;
  const shown = projects.filter((project) => !hidden.has(project.repo));

  useEffect(() => {
    const navigate = (event: Event) => {
      const destination = destinationOf(event);
      if (!destination) {
        return;
      }
      if (destination.repo !== undefined) {
        if (destination.repo !== null && !projects.some((project) => project.repo === destination.repo)) {
          return;
        }
        if (destination.repo !== null && hidden.has(destination.repo)) {
          return;
        }
        setScope(destination.repo ?? undefined);
        setTab("all");
        return;
      }
      if (destination.section) {
        setTab(SECTIONS[destination.section]);
      }
    };
    window.addEventListener(WORKSPACE_NAVIGATE_EVENT, navigate);
    return () => window.removeEventListener(WORKSPACE_NAVIGATE_EVENT, navigate);
  }, [projects, hidden]);

  const selected = shown.find((project) => project.repo === scope);
  const currentScope = selected?.repo;
  const activeTab = tab === "settings" && (!selected || !repositoryConfig) ? "all" : tab;
  const visiblePulls = selected ? pulls.filter((pull) => pull.repo === selected.repo) : pulls;
  const visibleRuns = shownRuns(selected ? runs.filter((run) => run.repo === selected.repo) : runs, now);
  const running = visibleRuns.filter(active);
  const attentionPulls = visiblePulls.filter(pullNeedsAttention);
  const attentionRuns = visibleRuns.filter(runNeedsAttention);
  const attentionCount = attentionPulls.length + attentionRuns.length;
  const ready = visiblePulls.filter((pull) => columnOf(pull) === "ready");
  const overviewRuns = sortRuns(visibleRuns).slice(0, 1);
  const actions = useActions()?.runs;
  const listed = [...shown]
    .sort((a, b) => a.name.localeCompare(b.name))
    .filter(
      (project) =>
        project.name.toLowerCase().includes(filter.toLowerCase()) ||
        project.repo.toLowerCase().includes(filter.toLowerCase()),
    );
  const tabs: { value: VisibleTab; label: string; count?: number }[] = [
    { value: "all", label: "Overview" },
    { value: "pulls", label: "Pull requests", count: visiblePulls.length },
    { value: "workflows", label: "Workflows", count: running.length },
    {
      value: "releases",
      label: "Releases",
      count: (selected ? [selected] : shown).filter((one) => one.latestRelease).length,
    },
    { value: "attention", label: "Needs attention", count: attentionCount },
    ...(selected && repositoryConfig ? [{ value: "settings" as const, label: "Settings" }] : []),
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
          <span class="workspace-nav-icon">
            <Icon name="overview" />
          </span>
          <span>Overview</span>
          <span class="workspace-nav-count">{shown.length}</span>
        </button>
        <label class="workspace-search-wrap">
          <span class="visually-hidden">Filter repositories</span>
          <Icon name="search" />
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

      <div class={activeTab === "settings" ? "workspace-main workspace-settings-view" : "workspace-main"}>
        <nav class="workspace-tabs" aria-label="Workspace sections">
          {tabs.map((one) => (
            <button
              key={one.value}
              type="button"
              aria-label={one.label}
              aria-pressed={activeTab === one.value || (one.value === "pulls" && activeTab === "ready")}
              onClick={() => setTab(one.value)}
            >
              <span class="workspace-tab-icon" aria-hidden="true">
                <Icon name={TAB_ICONS[one.value]} />
              </span>
              {one.label}
              {one.count !== undefined && <span class="count">{one.count}</span>}
            </button>
          ))}
        </nav>

        <header class="workspace-intro" id="workspace-content" tabindex={-1}>
          <div class="workspace-repo-mark" aria-hidden="true">
            {selected ? selected.name.slice(0, 1).toUpperCase() : <Icon name="command" size={20} />}
          </div>
          <div class="workspace-intro-copy">
            <p class="workspace-breadcrumb">
              Repositories <span aria-hidden="true">›</span> {selected?.name ?? "Overview"}
            </p>
            <div class="workspace-title-line">
              <h2>{selected ? selected.name : "Overview"}</h2>
              {selected && <span class="badge">{selected.private ? "Private" : "Public"}</span>}
              {selected?.latestRelease && <span class="badge badge-accent">{selected.latestRelease.tag}</span>}
              {selected && <Unreleased project={selected} />}
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

        {selected && repositoryConfig && activeTab === "settings" && (
          <RepositorySettings key={selected.repo} repo={selected.repo} service={repositoryConfig} />
        )}

        {activeTab !== "settings" && (
          <>
            <section class="workspace-metrics" aria-label="Dashboard summary">
              <button
                type="button"
                class="workspace-metric metric-pulls"
                aria-label={`Show ${visiblePulls.length} open pull requests`}
                onClick={() => setTab("pulls")}
              >
                <span class="workspace-metric-icon" aria-hidden="true">
                  <Icon name="pull-request" />
                </span>
                <span>OPEN PULL REQUESTS</span>
                <strong>{visiblePulls.length}</strong>
                <small>{selected ? "In this repository" : "Across visible repositories"}</small>
              </button>
              <button
                type="button"
                class="workspace-metric metric-running"
                aria-label={`Show ${running.length} active workflows`}
                onClick={() => setTab("workflows")}
              >
                <span class="workspace-metric-icon" aria-hidden="true">
                  <Icon name="workflow" />
                </span>
                <span>ACTIVE WORKFLOWS</span>
                <strong>{running.length}</strong>
                <small>Running or awaiting approval</small>
              </button>
              <button
                type="button"
                class="workspace-metric metric-ready"
                aria-label={`Show ${ready.length} pull requests ready to merge`}
                onClick={() => setTab("ready")}
              >
                <span class="workspace-metric-icon" aria-hidden="true">
                  <Icon name="check" />
                </span>
                <span>READY TO MERGE</span>
                <strong>{ready.length}</strong>
                <small>Checks passed and mergeable</small>
              </button>
              <button
                type="button"
                class="workspace-metric metric-attention"
                aria-label={`Show ${attentionCount} items needing attention`}
                onClick={() => setTab("attention")}
              >
                <span class="workspace-metric-icon" aria-hidden="true">
                  <Icon name="attention" />
                </span>
                <span>NEEDS ATTENTION</span>
                <strong class={attentionCount ? "workspace-alert-number" : ""}>{attentionCount}</strong>
                <small>Failed, conflicted or waiting</small>
              </button>
            </section>

            <div class={activeTab === "all" ? "workspace-content" : "workspace-content workspace-content-focused"}>
              {activeTab === "all" && (
                <>
                  <PullList
                    key={`overview:${currentScope ?? "all"}`}
                    pulls={visiblePulls}
                    now={now}
                    compact
                    showRepository={selected === undefined}
                  />
                  <div class="workspace-operations">
                    <ReleaseList runs={overviewRuns} now={now} inspect />
                    {visibleRuns.length > overviewRuns.length && (
                      <button type="button" class="workspace-view-all" onClick={() => setTab("workflows")}>
                        View all {visibleRuns.length} workflows
                      </button>
                    )}
                    <ReleasePanel projects={selected ? [selected] : shown} now={now} />
                  </div>
                </>
              )}
              {activeTab === "pulls" && (
                <PullList
                  key={`pulls:${currentScope ?? "all"}`}
                  pulls={visiblePulls}
                  now={now}
                  compact
                  showRepository={selected === undefined}
                />
              )}
              {activeTab === "ready" && (
                <PullList
                  key={`ready:${currentScope ?? "all"}`}
                  pulls={ready}
                  now={now}
                  compact
                  showRepository={selected === undefined}
                />
              )}
              {activeTab === "workflows" && <ReleaseList runs={visibleRuns} now={now} inspect />}
              {activeTab === "releases" && <ReleasePanel projects={selected ? [selected] : shown} now={now} />}
              {activeTab === "attention" && (
                <div class="workspace-attention-view">
                  <PullList
                    key={`attention:${currentScope ?? "all"}`}
                    pulls={attentionPulls}
                    now={now}
                    compact
                    showRepository={selected === undefined}
                  />
                  <ReleaseList runs={attentionRuns} now={now} inspect />
                </div>
              )}
            </div>
          </>
        )}
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
