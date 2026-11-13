import { useState } from "preact/hooks";
import { NOTICE_TYPES } from "../model.ts";
import {
  askPermission,
  NOTICE_LABELS,
  type NotificationSettings,
  type Notifier,
  type Permission,
  permission,
  readSettings,
  writeSettings,
} from "../notifications.ts";
import { chooseTheme, rememberedTheme, THEMES, type Theme } from "../theme.ts";
import type { LaneColumns } from "./ViewSwitch.tsx";

const LANE_COLUMNS: { value: LaneColumns; label: string }[] = [
  { value: 2, label: "Two columns" },
  { value: 1, label: "One column, each lane the full width" },
];

/**
 * The settings page: which things that need attention show as desktop notifications while the dashboard is open, the
 * browser's permission to show them at all, light or dark or following the system, and how the Lanes view uses a wide
 * screen.
 */
export function Settings({
  notifier,
  ask = askPermission,
  current = permission,
  laneColumns = 2,
  onLaneColumns,
  safariTab = isSafariTab(),
}: {
  notifier: Notifier;
  /** How to ask for the browser's permission, and read it; tests pass their own. */
  ask?: () => Promise<Permission>;
  current?: () => Permission;
  /** How many lanes stand side by side on a wide screen, and how to choose; without `onLaneColumns` it isn't asked. */
  laneColumns?: LaneColumns | undefined;
  onLaneColumns?: ((columns: LaneColumns) => void) | undefined;
  /** Whether the page is open in a Safari tab, rather than as a web app in the Dock; tests pass their own. */
  safariTab?: boolean;
}) {
  const [settings, setSettings] = useState<NotificationSettings>(readSettings);
  const [allowed, setAllowed] = useState<Permission>(current);
  const [theme, setTheme] = useState<Theme>(rememberedTheme);

  function toggle(type: keyof NotificationSettings) {
    const next = { ...settings, [type]: !settings[type] };
    writeSettings(next);
    setSettings(next);
  }

  return (
    <>
      <section class="panel settings" aria-labelledby="notifications-heading">
        <div class="panel-heading">
          <h2 id="notifications-heading">Notifications</h2>
          <a href="#dashboard">Back to the dashboard</a>
        </div>
        <div class="settings-body">
          <p>
            While the dashboard is open on this computer, including in a background tab, what needs attention shows as a
            notification from the browser, in macOS's Notification Center. Once every dashboard page is closed or its
            connection has been suspended for 30 seconds, the same things go to Telegram instead, if it is set up.
          </p>

          <div class="permission">
            {allowed === "granted" && (
              <>
                <span>This browser may show notifications.</span>
                <button type="button" onClick={() => notifier.test()}>
                  Send a test
                </button>
              </>
            )}
            {allowed === "default" && (
              <>
                <span>This browser hasn't been allowed to show notifications yet.</span>
                <button type="button" onClick={async () => setAllowed(await ask())}>
                  Allow notifications
                </button>
              </>
            )}
            {allowed === "denied" && (
              <span class="problem">
                Notifications are blocked for this site. Allow them in the browser's site settings, and in macOS's
                System Settings under Notifications for the browser, then reload.
              </span>
            )}
            {allowed === "unsupported" && <span class="problem">This browser can't show notifications.</span>}
          </div>
          {safariTab && (
            <p class="quiet">
              Safari puts its own logo on a tab's notifications, whatever the page asks for. To have the dashboard's
              icon on them, add it to the Dock (File, Add to Dock), open it from there, and allow notifications once
              more.
            </p>
          )}

          <fieldset>
            <legend>Show a notification when</legend>
            {NOTICE_TYPES.map((type) => (
              <label key={type}>
                <input type="checkbox" checked={settings[type]} onChange={() => toggle(type)} />
                {NOTICE_LABELS[type].setting}
              </label>
            ))}
          </fieldset>
          <p class="quiet">
            Kept in this browser. Hidden projects send none. Telegram's messages are set on the server and aren't
            changed here.
          </p>
        </div>
      </section>
      <section class="panel settings" aria-labelledby="appearance-heading">
        <div class="panel-heading">
          <h2 id="appearance-heading">Appearance</h2>
        </div>
        <div class="settings-body">
          <fieldset>
            <legend>Theme</legend>
            {THEMES.map(({ value, label }) => (
              <label key={value}>
                <input
                  type="radio"
                  name="theme"
                  checked={theme === value}
                  onChange={() => {
                    chooseTheme(value);
                    setTheme(value);
                  }}
                />
                {label}
              </label>
            ))}
          </fieldset>
          <p class="quiet">Kept in this browser. The Workspace view and the review overlay are always dark.</p>
        </div>
      </section>
      {onLaneColumns && (
        <section class="panel settings" aria-labelledby="layout-heading">
          <div class="panel-heading">
            <h2 id="layout-heading">Layout</h2>
          </div>
          <div class="settings-body">
            <fieldset>
              <legend>Lanes on a wide screen</legend>
              {LANE_COLUMNS.map(({ value, label }) => (
                <label key={value}>
                  <input
                    type="radio"
                    name="lane-columns"
                    checked={laneColumns === value}
                    onChange={() => onLaneColumns(value)}
                  />
                  {label}
                </label>
              ))}
            </fieldset>
            <p class="quiet">Kept in this browser. A window narrower than 1600 pixels always shows one column.</p>
          </div>
        </section>
      )}
    </>
  );
}

/**
 * Whether this is a Safari tab: Safari on a Mac, and not the dashboard opened from the Dock, which is a window of its
 * own whose notifications carry its own icon. Chrome, Edge and Firefox use the icon the page gives them.
 */
export function isSafariTab(): boolean {
  if (typeof navigator === "undefined") {
    return false;
  }
  const agent = navigator.userAgent;
  const safari = agent.includes("Safari/") && !/Chrome\/|Chromium\/|Edg\/|Firefox\//.test(agent);
  const standalone =
    (navigator as { standalone?: boolean }).standalone === true ||
    (typeof matchMedia === "function" && matchMedia("(display-mode: standalone)").matches);
  return safari && !standalone;
}
