import type { ComponentChildren } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import type { Auth } from "../auth.ts";
import { Icon } from "./Icon.tsx";

type User = { login: string; avatar_url: string };

const MENU_ID = "account-menu";

/**
 * Who is signed in, and the way out. `children` go with them: links that belong in the header, such as Settings.
 * A wide screen shows it all in a row; a phone folds it behind the avatar, which opens it as a menu.
 */
export function Account({ auth, children }: { auth: Auth; children?: ComponentChildren }) {
  const [user, setUser] = useState<User | "failed">();
  const [signOutFailed, setSignOutFailed] = useState(false);
  const [open, setOpen] = useState(false);
  const control = useRef<HTMLFieldSetElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    auth
      .github("user")
      .then(async (response) => setUser(response.ok ? ((await response.json()) as User) : "failed"))
      .catch(() => setUser("failed"));
  }, [auth]);

  // Like the header's other menus: a tap outside closes it.
  useEffect(() => {
    if (!open) {
      return;
    }
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !control.current?.contains(event.target)) {
        setOpen(false);
      }
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);

  // Going to another page, as the Settings link does, leaves the menu behind.
  useEffect(() => {
    const close = () => setOpen(false);
    window.addEventListener("hashchange", close);
    return () => window.removeEventListener("hashchange", close);
  }, []);

  const signedInAs = user && user !== "failed" ? user : undefined;
  return (
    <fieldset
      ref={control}
      aria-label="Account"
      class={open ? "account account-open" : "account"}
      onKeyDown={(event) => {
        if (open && event.key === "Escape") {
          event.preventDefault();
          setOpen(false);
          trigger.current?.focus();
        }
      }}
      onFocusOut={(event) => {
        if (open && event.relatedTarget instanceof Node && !control.current?.contains(event.relatedTarget)) {
          setOpen(false);
        }
      }}
    >
      <button
        ref={trigger}
        type="button"
        class="account-toggle"
        aria-expanded={open}
        aria-controls={MENU_ID}
        aria-label="Account menu"
        title="Account menu"
        onClick={() => setOpen(!open)}
      >
        {signedInAs ? (
          <img class="avatar" src={signedInAs.avatar_url} alt="" width="28" height="28" />
        ) : (
          <Icon name="overview" />
        )}
      </button>
      <div id={MENU_ID} class="account-items">
        {children}
        {user === "failed" && <span class="problem">Couldn't load your GitHub account</span>}
        {signedInAs && (
          <span class="account-who">
            <img class="avatar" src={signedInAs.avatar_url} alt="" width="28" height="28" />
            <span class="login">{signedInAs.login}</span>
          </span>
        )}
        {signOutFailed && (
          <span role="alert" class="problem">
            Sign-out didn't work
          </span>
        )}
        <button type="button" onClick={async () => setSignOutFailed(!(await auth.signOut()))}>
          Sign out
        </button>
      </div>
    </fieldset>
  );
}
