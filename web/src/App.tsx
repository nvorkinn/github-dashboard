import { useCallback, useEffect, useMemo, useState } from "preact/hooks";
import type { Auth, AuthState } from "./auth.ts";
import { Account } from "./components/Account.tsx";
import { type Actions, ActionsContext } from "./components/actions.tsx";
import { CommandPalette, type PaletteCommand } from "./components/CommandPalette.tsx";
import { DashboardView, Freshness, useRefresh } from "./components/DashboardView.tsx";
import { ExternalLink } from "./components/ExternalLink.tsx";
import { readHidden, useDashboardState, useNow } from "./components/hooks.ts";
import { Icon, type IconName } from "./components/Icon.tsx";
import { NotificationCentre } from "./components/NotificationCentre.tsx";
import { ServiceStatus, ServiceStatusSummary, useServiceStatus } from "./components/ServiceStatus.tsx";
import { Settings } from "./components/Settings.tsx";
import { useLaneColumns, useView, ViewSwitch } from "./components/ViewSwitch.tsx";
import { navigateWorkspace, type WorkspaceDestination } from "./components/Workspace.tsx";
import { type Dashboard, type DashboardState, summarize } from "./model.ts";
import {
  addNotificationHistory,
  clearNotificationHistory,
  createNotifier,
  type Notifier,
  readNotificationHistory,
} from "./notifications.ts";

/** The pull request a demo was built from, which its note links back to. */
export interface DemoPull {
  number: number;
  title: string;
  url: string;
}

/**
 * The page: sign-in, and behind it the dashboard. Without `actions` the dashboard only shows. `pull` is set on a pull
 * request's demo.
 */
export function App({
  auth,
  dashboard,
  actions,
  demo = false,
  notifier,
  pull,
}: {
  auth: Auth;
  dashboard: Dashboard;
  actions?: Actions | undefined;
  demo?: boolean;
  /** Shows the desktop notifications. Left out, the browser's, as the settings page sets them. */
  notifier?: Notifier | undefined;
  pull?: DemoPull | undefined;
}) {
  const state = useAuthState(auth);
  const signedIn = state.status === "signedIn";

  useEffect(() => {
    void auth.start();
  }, [auth]);

  // The dashboard reads as the signed-in user, so it runs exactly as long as there is one.
  useEffect(() => {
    if (!signedIn) {
      return;
    }
    dashboard.start();
    return () => dashboard.stop();
  }, [signedIn, dashboard]);

  return (
    <>
      {demo && (
        <p role="note" class="demo-note">
          {pull ? (
            <>
              Demo of{" "}
              <ExternalLink href={pull.url}>
                #{pull.number} {pull.title}
              </ExternalLink>
              : sample data, nothing here is real.
            </>
          ) : (
            "Demo: sample data, nothing here is real."
          )}
        </p>
      )}
      {signedIn ? (
        <SignedIn auth={auth} dashboard={dashboard} actions={actions} notifier={notifier} />
      ) : (
        <>
          <header class="top">
            <h1>GitHub dashboard</h1>
          </header>
          <main>
            {state.status === "loading" && <p class="quiet">Loading…</p>}
            {state.status === "signedOut" && (
              <>
                {state.failed && (
                  <p role="alert" class="problem">
                    Sign-in didn't work. Try again.
                  </p>
                )}
                {/* A plain link: signing in is a trip to github.com and back, which the relay starts. */}
                <a class="button" href="api/auth/login">
                  Sign in with GitHub
                </a>
              </>
            )}
            {state.status === "unavailable" && (
              <p role="alert" class="problem">
                Can't reach the sign-in service. Reload to try again.
              </p>
            )}
          </main>
        </>
      )}
    </>
  );
}

function SignedIn({
  auth,
  dashboard,
  actions,
  notifier: given,
}: {
  auth: Auth;
  dashboard: Dashboard;
  actions: Actions | undefined;
  notifier: Notifier | undefined;
}) {
  const state = useDashboardState(dashboard);
  const now = useNow();
  const { refresh, pending } = useRefresh(dashboard);
  const page = usePage();
  const notifier = useMemo(() => given ?? createNotifier({ hidden: readHidden }), [given]);
  const [notices, setNotices] = useState(readNotificationHistory);
  const status = useServiceStatus();
  const [statusOpen, setStatusOpen] = useState(false);
  const closeStatus = useCallback(() => setStatusOpen(false), []);
  const openStatus = () => {
    setNotificationsOpen(false);
    setPaletteOpen(false);
    setStatusOpen(true);
  };
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [pendingWorkspace, setPendingWorkspace] = useState<WorkspaceDestination | undefined>(undefined);

  // What needs attention shows as a desktop notification, for as long as the dashboard runs.
  useEffect(
    () =>
      dashboard.onNotice?.((notice) => {
        notifier.notify(notice);
        if (!readHidden().has(notice.repo)) {
          setNotices(addNotificationHistory(notice));
        }
      }),
    [dashboard, notifier],
  );

  const [view, setView] = useView();
  const [laneColumns, setLaneColumns] = useLaneColumns();
  const commandCentre = view === "workspace" && page === "dashboard";
  const hiddenRepositories = readHidden();
  const openWorkspace = (destination?: WorkspaceDestination) => {
    setView("workspace");
    if (destination) {
      setPendingWorkspace(destination);
    }
    location.hash = "#dashboard";
  };
  const commands: PaletteCommand[] = [
    {
      id: "view:workspace",
      label: "Open Workspace",
      group: "Views",
      keywords: ["command centre", "dashboard"],
      run: () => openWorkspace(),
    },
    {
      id: "view:stage",
      label: "Open Stage",
      group: "Views",
      run: () => {
        setView("stage");
        location.hash = "#dashboard";
      },
    },
    {
      id: "view:lanes",
      label: "Open Lanes",
      group: "Views",
      run: () => {
        setView("lanes");
        location.hash = "#dashboard";
      },
    },
    {
      id: "action:refresh",
      label: "Refresh dashboard",
      group: "Actions",
      run: refresh,
    },
    {
      id: "page:settings",
      label: "Open Settings",
      group: "Navigation",
      run: () => {
        location.hash = "#settings";
      },
    },
    ...workspaceCommands(openWorkspace),
    ...(state.status === "ready"
      ? state.data.projects
          .filter((project) => !hiddenRepositories.has(project.repo))
          .map(
            (project): PaletteCommand => ({
              id: `repo:${project.repo}`,
              label: `Open ${project.name}`,
              group: "Repositories",
              keywords: [project.repo],
              run: () => openWorkspace({ repo: project.repo }),
            }),
          )
      : []),
  ];

  useEffect(() => {
    if (view !== "workspace" || !pendingWorkspace) {
      return;
    }
    const timer = setTimeout(() => {
      navigateWorkspace(pendingWorkspace);
      setPendingWorkspace(undefined);
    }, 0);
    return () => clearTimeout(timer);
  }, [view, pendingWorkspace]);

  useEffect(() => {
    const open = (event: KeyboardEvent) => {
      if (
        !event.defaultPrevented &&
        !event.isComposing &&
        (event.metaKey || event.ctrlKey) &&
        event.key.toLowerCase() === "k"
      ) {
        event.preventDefault();
        setNotificationsOpen(false);
        setStatusOpen(false);
        setPaletteOpen(true);
      }
    };
    window.addEventListener("keydown", open);
    return () => window.removeEventListener("keydown", open);
  }, []);
  return (
    <>
      {commandCentre && (
        <a class="skip-link" href="#workspace-content">
          Skip to dashboard content
        </a>
      )}
      <header class={commandCentre ? "top command-top" : "top"}>
        <div class={commandCentre ? "command-brand" : undefined}>
          {commandCentre && (
            <span class="command-mark">
              <Icon name="command" size={22} />
            </span>
          )}
          <h1>
            <a class="home" href="#dashboard">
              {commandCentre ? "GitHub Command Centre" : "GitHub dashboard"}
            </a>
          </h1>
          {commandCentre && <p>Build · Review · Release · Operate</p>}
        </div>
        {commandCentre && <CommandSummary state={state} />}
        <div class="top-controls">
          <ServiceStatus state={status} open={statusOpen} onOpen={openStatus} onClose={closeStatus} />
          <ViewSwitch
            view={view}
            onChange={(next) => {
              setView(next);
              // Picking a view from the settings page goes to it.
              if (page === "settings") {
                location.hash = "#dashboard";
              }
            }}
          />
          <Freshness state={state} now={now} refresh={refresh} pending={pending} />
          <button
            type="button"
            class="header-icon-button command-palette-trigger"
            title="Open command palette (Command or Control + K)"
            onClick={() => {
              setNotificationsOpen(false);
              setStatusOpen(false);
              setPaletteOpen(true);
            }}
          >
            <Icon name="command" />
            <span class="visually-hidden">Open command palette</span>
          </button>
          <a class="button" href="#settings" aria-current={page === "settings" ? "page" : undefined}>
            Settings
          </a>
          <NotificationCentre
            notices={notices}
            open={notificationsOpen}
            onOpen={() => {
              setStatusOpen(false);
              setPaletteOpen(false);
              setNotificationsOpen(true);
            }}
            onClose={() => setNotificationsOpen(false)}
            onClear={() => {
              clearNotificationHistory();
              setNotices([]);
            }}
          />
          <Account auth={auth} />
        </div>
      </header>
      <main class={commandCentre ? "command-main" : undefined}>
        {page === "dashboard" && <ServiceStatusSummary state={status} onOpen={openStatus} />}
        {page === "settings" ? (
          <Settings notifier={notifier} laneColumns={laneColumns} onLaneColumns={setLaneColumns} />
        ) : (
          <ActionsContext.Provider value={actions}>
            <DashboardView state={state} now={now} refresh={refresh} view={view} laneColumns={laneColumns} />
          </ActionsContext.Provider>
        )}
      </main>
      <CommandPalette open={paletteOpen} commands={commands} onClose={() => setPaletteOpen(false)} />
    </>
  );
}

function workspaceCommands(open: (destination: WorkspaceDestination) => void): PaletteCommand[] {
  return [
    { id: "workspace:overview", label: "Workspace overview", group: "Workspace", run: () => open({ repo: null }) },
    { id: "workspace:pulls", label: "Open pull requests", group: "Workspace", run: () => open({ section: "pulls" }) },
    {
      id: "workspace:workflows",
      label: "Open workflows",
      group: "Workspace",
      run: () => open({ section: "workflows" }),
    },
    { id: "workspace:releases", label: "Open releases", group: "Workspace", run: () => open({ section: "releases" }) },
    {
      id: "workspace:attention",
      label: "Show items needing attention",
      group: "Workspace",
      keywords: ["failed conflicts waiting"],
      run: () => open({ section: "attention" }),
    },
  ];
}

function CommandSummary({ state }: { state: DashboardState }) {
  if (state.status !== "ready") {
    return (
      <div class="command-summary command-summary-loading" role="status">
        <span class="visually-hidden">Loading dashboard summary</span>
      </div>
    );
  }
  const active = state.data.releases.filter(
    (run) => ["running", "waiting", "queued"].includes(run.state) && !run.finishedAt,
  ).length;
  const ready = state.data.pulls.filter((pull) => {
    const checks = summarize(pull.checks);
    return !pull.draft && pull.mergeState === "clean" && (checks === "passed" || checks === "none");
  }).length;
  const attention =
    state.data.pulls.filter((pull) => {
      const checks = summarize(pull.checks);
      return checks === "failed" || pull.mergeState === "conflicts" || pull.mergeState === "behind";
    }).length +
    state.data.releases.filter(
      (run) =>
        run.state === "failed" || run.state === "cancelled" || run.state === "waiting" || run.approvals.length > 0,
    ).length;
  const metrics: { label: string; value: number; icon: IconName; tone: string }[] = [
    { label: "Open PRs", value: state.data.pulls.length, icon: "pull-request", tone: "done" },
    { label: "Running", value: active, icon: "workflow", tone: "running" },
    { label: "Ready PRs", value: ready, icon: "check", tone: "done" },
    { label: "Attention", value: attention, icon: "attention", tone: attention ? "waiting" : "done" },
  ];
  return (
    <section class="command-summary" aria-label="Global dashboard summary">
      {metrics.map((metric) => (
        <div key={metric.label} class={`command-stat command-stat-${metric.tone}`}>
          <span class="command-stat-icon" aria-hidden="true">
            <Icon name={metric.icon} size={17} />
          </span>
          <strong>{metric.value}</strong>
          <span>{metric.label}</span>
        </div>
      ))}
    </section>
  );
}

type Page = "dashboard" | "settings";

/** Which page the address names: `#settings` the settings, anything else the dashboard. Back and forward work. */
function usePage(): Page {
  const read = (): Page =>
    typeof location !== "undefined" && location.hash === "#settings" ? "settings" : "dashboard";
  const [page, setPage] = useState(read);
  useEffect(() => {
    const onHash = () => setPage(read());
    // Read again too, for a change between drawing and listening.
    onHash();
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  return page;
}

function useAuthState(auth: Auth): AuthState {
  const [state, setState] = useState(auth.state());
  useEffect(() => {
    setState(auth.state());
    return auth.subscribe(() => setState(auth.state()));
  }, [auth]);
  return state;
}
