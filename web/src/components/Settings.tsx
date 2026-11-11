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
import type { LaneColumns } from "./ViewSwitch.tsx";

const LANE_COLUMNS: { value: LaneColumns; label: string }[] = [
  { value: 2, label: "Two columns" },
  { value: 1, label: "One column, each lane the full width" },
];

/**
 * The settings page: which things that need attention show as desktop notifications while the dashboard is open, the
 * browser's permission to show them at all, and how the Lanes view uses a wide screen.
 */
export function Settings({
  notifier,
  ask = askPermission,
  current = permission,
  laneColumns = 2,
  onLaneColumns,
}: {
  notifier: Notifier;
  /** How to ask for the browser's permission, and read it; tests pass their own. */
  ask?: () => Promise<Permission>;
  current?: () => Permission;
  /** How many lanes stand side by side on a wide screen, and how to choose; without `onLaneColumns` it isn't asked. */
  laneColumns?: LaneColumns | undefined;
  onLaneColumns?: ((columns: LaneColumns) => void) | undefined;
}) {
  const [settings, setSettings] = useState<NotificationSettings>(readSettings);
  const [allowed, setAllowed] = useState<Permission>(current);

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
