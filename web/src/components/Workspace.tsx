import { useEffect, useRef, useState } from "preact/hooks";
import type { BarePull, Project, PullRequest, ReleaseRun } from "../model.ts";
import { summarize } from "../model.ts";
import { useActions } from "./actions.tsx";
import { ExternalLink } from "./ExternalLink.tsx";
import { Icon, type IconName } from "./Icon.tsx";
import { ProjectActions, ProjectList } from "./ProjectList.tsx";
import { PullList } from "./PullList.tsx";
import { ReleaseList, shownRuns, sortRuns } from "./ReleaseList.tsx";
import { RepositorySettings } from "./RepositorySettings.tsx";
import { SidebarReleaseDrawer, SidebarReleaseLine, SidebarReleaseToggle, waiting } from "./SidebarRelease.tsx";
import { Unreleased } from "./Unreleased.tsx";
import "./Workspace.css";

type Scope = string | undefined;
type WorkspaceTab = "all" | "pulls" | "workflows" | "releases" | "attention" | "settings";

const TAB_ICONS: Record<WorkspaceTab, IconName> = {
  all: "overview",
  pulls: "pull-request",
  workflows: "workflow",
  releases: "release",
  attention: "attention",
  settings: "settings",
};

/** How many workflows the overview shows before "View all". */
export const OVERVIEW_RUNS = 3;

const ACTIVE_RUNS = new Set(["running", "waiting", "queued"]);
// A preference, not a secret: fine to keep in the browser.
const SIDEBAR_KEY = "github-dashboard:sidebar";

export function rememberedSidebarCollapsed(): boolean {
  try {
    return localStorage.getItem(SIDEBAR_KEY) === "collapsed";
  } catch {
    // Storage can be switched off; open will do.
    return false;
  }
}

/** Whether the repository sidebar is folded to a narrow rail, as the browser remembers it, and a way to change it. */
function useSidebarCollapsed(): [boolean, (collapsed: boolean) => void] {
  const [collapsed, setCollapsed] = useState(rememberedSidebarCollapsed);
  return [
    collapsed,
    (chosen) => {
      setCollapsed(chosen);
      try {
        if (chosen) {
          localStorage.setItem(SIDEBAR_KEY, "collapsed");
        } else {
          localStorage.removeItem(SIDEBAR_KEY);
        }
      } catch {
        // Not remembered, then.
      }
    },
  ];
}

/**
 * The repository sidebar as a phone shows it: a drawer over the page, opened from the tab bar. Focus goes into it
 * when it opens and back to its button when it closes. Wider screens never open it, so it changes nothing there.
 */
function useSidebarDrawer() {
  const [open, setOpen] = useState(false);
  const panel = useRef<HTMLElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const wasOpen = useRef(false);
  useEffect(() => {
    if (open) {
      panel.current?.querySelector<HTMLElement>(".workspace-nav.active, .workspace-nav")?.focus();
    } else if (wasOpen.current) {
      toggle.current?.focus();
    }
    wasOpen.current = open;
  }, [open]);
  return { open, panel, toggle, show: () => setOpen(true), close: () => setOpen(false) };
}

/**
 * Keeps `--command-top-height` at the header's real height, so the sticky sidebar starts below it even when the
 * header's controls wrap onto a second line.
 */
function useHeaderHeight(): void {
  useEffect(() => {
    const header = document.querySelector<HTMLElement>(".command-top");
    if (!header || typeof ResizeObserver === "undefined") {
      return;
    }
    const root = document.documentElement;
    const update = () => root.style.setProperty("--command-top-height", `${header.offsetHeight}px`);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(header);
    return () => {
      observer.disconnect();
      root.style.removeProperty("--command-top-height");
    };
  }, []);
}

/** The first letters of a repository's name, which stand for it on the folded rail. */
function initials(name: string): string {
  const words = name.split(/[^A-Za-z0-9]+/).filter(Boolean);
  const letters = words.length > 1 ? `${words[0]?.[0]}${words[1]?.[0]}` : name.slice(0, 2);
  return letters.toUpperCase();
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
  hiddenPulls = [],
}: {
  projects: Project[];
  pulls: PullRequest[];
  runs: ReleaseRun[];
  now: number;
  hidden: ReadonlySet<string>;
  onToggle: (repo: string) => void;
  /** The hidden projects' open pull requests, bare, by project. */
  hiddenPulls?: HiddenPulls[];
}) {
  const [scope, setScope] = useState<Scope>(undefined);
  const [tab, setTab] = useState<WorkspaceTab>("all");
  const [filter, setFilter] = useState("");
  const [collapsed, setCollapsed] = useSidebarCollapsed();
  const sheet = useSidebarDrawer();
  // The repository whose release controls are unfolded in the sidebar; one at a time.
  const [releaseOpen, setReleaseOpen] = useState<string | undefined>(undefined);
  // Once a release or promotion has started, its drawer folds away; the focus, if it was in there, goes back to the
  // drawer's toggle rather than being lost with the drawer.
  const closeReleaseDrawer = (repo: string, drawer: string) => {
    const wasInside = document.getElementById(drawer)?.contains(document.activeElement) ?? false;
    setReleaseOpen((current) => (current === repo ? undefined : current));
    if (wasInside) {
      setTimeout(() => document.querySelector<HTMLElement>(`[aria-controls="${drawer}"]`)?.focus());
    }
  };
  useHeaderHeight();
  const repositoryConfig = useActions()?.repositories;
  const secretCopy = useActions()?.secrets;
  const shown = projects.filter((project) => !hidden.has(project.repo));

  const selected = shown.find((project) => project.repo === scope);
  const currentScope = selected?.repo;
  const activeTab = tab === "settings" && (!selected || !repositoryConfig) ? "all" : tab;
  const visiblePulls = selected ? pulls.filter((pull) => pull.repo === selected.repo) : pulls;
  const visibleRuns = shownRuns(selected ? runs.filter((run) => run.repo === selected.repo) : runs, now);
  const running = visibleRuns.filter(active);
  const attentionPulls = visiblePulls.filter(pullNeedsAttention);
  const attentionRuns = visibleRuns.filter(runNeedsAttention);
  const attentionCount = attentionPulls.length + attentionRuns.length;
  const overviewRuns = sortRuns(visibleRuns).slice(0, OVERVIEW_RUNS);
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
    ...(selected && repositoryConfig ? [{ value: "settings" as const, label: "Settings" }] : []),
  ];

  return (
    <div
      class={["workspace", collapsed && "sidebar-collapsed", sheet.open && "sidebar-drawer-open"]
        .filter(Boolean)
        .join(" ")}
    >
      {sheet.open && (
        // The tap target to close the drawer; Escape and the close button do the same from a keyboard.
        <div class="workspace-drawer-backdrop" aria-hidden="true" onClick={sheet.close} />
      )}
      <aside
        id="workspace-sidebar"
        ref={sheet.panel}
        class="workspace-sidebar"
        aria-label="Repository navigation"
        onKeyDown={(event) => {
          if (sheet.open && event.key === "Escape") {
            event.preventDefault();
            sheet.close();
          }
        }}
      >
        <div class="workspace-sidebar-head">
          <h2>Repositories</h2>
          <span class="workspace-sidebar-total">{shown.length}</span>
          <button
            type="button"
            class="workspace-sidebar-toggle"
            aria-controls="workspace-sidebar"
            aria-expanded={!collapsed}
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            onClick={() => setCollapsed(!collapsed)}
          >
            <Icon name="sidebar" />
          </button>
          <button type="button" class="workspace-drawer-close" aria-label="Close repositories" onClick={sheet.close}>
            ×
          </button>
        </div>
        <button
          type="button"
          class={
            currentScope === undefined ? "workspace-nav workspace-overview active" : "workspace-nav workspace-overview"
          }
          aria-current={currentScope === undefined ? "page" : undefined}
          title={collapsed ? "Overview" : undefined}
          onClick={() => {
            setScope(undefined);
            setTab("all");
            sheet.close();
          }}
        >
          <span class="workspace-nav-icon">
            <Icon name="overview" />
          </span>
          <span class="workspace-nav-label">Overview</span>
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
            const drawer = `workspace-release-${project.repo.replace(/[^A-Za-z0-9_-]/g, "-")}`;
            // The folded rail has no room for the controls; a phone's drawer is never folded.
            const open = releaseOpen === project.repo && (!collapsed || sheet.open);
            const pending = (waiting(project) ?? 0) > 0;
            return (
              <div key={project.repo} class={open ? "workspace-repo release-open" : "workspace-repo"}>
                <div class="workspace-repo-row">
                  <button
                    type="button"
                    class={currentScope === project.repo ? "workspace-nav active" : "workspace-nav"}
                    aria-current={currentScope === project.repo ? "page" : undefined}
                    title={collapsed ? project.name : undefined}
                    onClick={() => {
                      setScope(project.repo);
                      setTab("all");
                      sheet.close();
                    }}
                  >
                    <span class="workspace-repo-name">
                      <span
                        class={
                          problem ? "workspace-status problem" : busy ? "workspace-status busy" : "workspace-status"
                        }
                        aria-hidden="true"
                      />
                      <span class="workspace-repo-initials" aria-hidden="true">
                        {initials(project.name)}
                      </span>
                      {pending && <span class="workspace-repo-pending" aria-hidden="true" />}
                      <span class="workspace-nav-label">{project.name}</span>
                    </span>
                    <SidebarReleaseLine project={project} now={now} />
                    {busy && <span class="visually-hidden">Active workflow</span>}
                    {problem && <span class="visually-hidden">Needs attention</span>}
                    {count > 0 && (
                      <span class="workspace-nav-count" title={`${count} open pull requests`}>
                        {count}
                      </span>
                    )}
                  </button>
                  <SidebarReleaseToggle
                    project={project}
                    open={open}
                    controls={drawer}
                    onToggle={() => setReleaseOpen(open ? undefined : project.repo)}
                  />
                </div>
                {open && (
                  <SidebarReleaseDrawer
                    id={drawer}
                    project={project}
                    actions={actions}
                    onStarted={() => closeReleaseDrawer(project.repo, drawer)}
                  />
                )}
              </div>
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

      <div
        class={activeTab === "settings" ? "workspace-main workspace-settings-view" : "workspace-main"}
        id="workspace-content"
        tabindex={-1}
      >
        <div class="workspace-tabbar">
          <button
            ref={sheet.toggle}
            type="button"
            class="workspace-drawer-toggle"
            aria-controls="workspace-sidebar"
            aria-expanded={sheet.open}
            onClick={sheet.show}
          >
            <Icon name="sidebar" />
            <span class="visually-hidden">Repositories: {selected ? selected.name : "all"}</span>
          </button>
          <nav class="workspace-tabs" aria-label="Workspace sections">
            {tabs.map((one) => (
              <button
                key={one.value}
                type="button"
                aria-label={one.label}
                aria-pressed={activeTab === one.value}
                onClick={() => setTab(one.value)}
              >
                <span class="workspace-tab-icon" aria-hidden="true">
                  <Icon name={TAB_ICONS[one.value]} />
                </span>
                <span class="workspace-tab-label">{one.label}</span>
                {one.count !== undefined && <span class="count">{one.count}</span>}
              </button>
            ))}
          </nav>
        </div>

        {selected && (
          <header class="workspace-intro">
            <div class="workspace-title-line">
              <h2>{selected.name}</h2>
              <span class="badge">{selected.private ? "Private" : "Public"}</span>
              {selected.latestRelease && <span class="badge badge-accent">{selected.latestRelease.tag}</span>}
              <Unreleased project={selected} />
            </div>
            <div class="workspace-intro-actions">
              <ExternalLink href={selected.url}>Open on GitHub</ExternalLink>
              {actions && <ProjectActions project={selected} actions={actions} />}
            </div>
          </header>
        )}

        {selected && repositoryConfig && activeTab === "settings" && (
          <RepositorySettings
            key={selected.repo}
            repo={selected.repo}
            service={repositoryConfig}
            secrets={secretCopy}
          />
        )}

        {activeTab !== "settings" && (
          <div class={activeTab === "all" ? "workspace-content" : "workspace-content workspace-content-focused"}>
            {activeTab === "all" && (
              <>
                <div class="workspace-pull-column">
                  <PullList
                    key={`overview:${currentScope ?? "all"}`}
                    pulls={visiblePulls}
                    now={now}
                    compact
                    showRepository={selected === undefined}
                  />
                  {!selected && <HiddenPullList groups={hiddenPulls} />}
                </div>
                <div class="workspace-operations">
                  <ReleaseList runs={overviewRuns} now={now} inspect />
                  {visibleRuns.length > overviewRuns.length && (
                    <button type="button" class="workspace-view-all" onClick={() => setTab("workflows")}>
                      View all {visibleRuns.length} workflows
                    </button>
                  )}
                </div>
              </>
            )}
            {activeTab === "pulls" && (
              <>
                <PullList
                  key={`pulls:${currentScope ?? "all"}`}
                  pulls={visiblePulls}
                  now={now}
                  compact
                  showRepository={selected === undefined}
                />
                {!selected && <HiddenPullList groups={hiddenPulls} />}
              </>
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
        )}
      </div>
    </div>
  );
}

/** A hidden project's open pull requests, bare. */
export type HiddenPulls = { project: Project; pulls: BarePull[] };

/**
 * The hidden projects' open pull requests, folded away under the shown ones: number, title and a link to GitHub,
 * nothing more, as nothing more of them is read. Nothing when they have none.
 */
function HiddenPullList({ groups }: { groups: HiddenPulls[] }) {
  const some = groups.filter((group) => group.pulls.length > 0);
  if (some.length === 0) {
    return null;
  }
  const count = some.reduce((sum, group) => sum + group.pulls.length, 0);
  return (
    <details class="hidden-pulls">
      <summary>
        Hidden projects <span class="count">{count}</span>
      </summary>
      {some.map(({ project, pulls }) => (
        <section key={project.repo} aria-label={project.name}>
          <h3 title={project.repo}>{project.name}</h3>
          <ul>
            {pulls.map((pull) => (
              <li key={pull.number}>
                <ExternalLink href={pull.url}>
                  <span class="hidden-pull-number">#{pull.number}</span> {pull.title}
                </ExternalLink>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </details>
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
