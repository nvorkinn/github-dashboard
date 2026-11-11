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

/**
 * The settings page: for now, which things that need attention show as desktop notifications while the dashboard is
 * open, and the browser's permission to show them at all.
 */
export function Settings({
  notifier,
  ask = askPermission,
  current = permission,
}: {
  notifier: Notifier;
  /** How to ask for the browser's permission, and read it; tests pass their own. */
  ask?: () => Promise<Permission>;
  current?: () => Permission;
}) {
  const [settings, setSettings] = useState<NotificationSettings>(readSettings);
  const [allowed, setAllowed] = useState<Permission>(current);

  function toggle(type: keyof NotificationSettings) {
    const next = { ...settings, [type]: !settings[type] };
    writeSettings(next);
    setSettings(next);
  }

  return (
    <section class="panel settings" aria-labelledby="notifications-heading">
      <div class="panel-heading">
        <h2 id="notifications-heading">Notifications</h2>
        <a href="#dashboard">Back to the dashboard</a>
      </div>
      <div class="settings-body">
        <p>
          While the dashboard is open on this computer, what needs attention shows as a notification from the browser,
          in macOS's Notification Center. Once no dashboard has been open for 30 seconds, including when its tab is in
          the background, the same things go to Telegram instead, if it is set up.
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
              Notifications are blocked for this site. Allow them in the browser's site settings, and in macOS's System
              Settings under Notifications for the browser, then reload.
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
          Kept in this browser. Hidden projects send none. Telegram's messages are set on the server and aren't changed
          here.
        </p>
      </div>
    </section>
  );
}
