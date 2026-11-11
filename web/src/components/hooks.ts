import { useCallback, useEffect, useState } from "preact/hooks";
import type { Dashboard, DashboardState } from "../model.ts";

/** The dashboard's state, drawn again whenever it changes. */
export function useDashboardState(dashboard: Dashboard): DashboardState {
  const [state, setState] = useState(dashboard.state());
  useEffect(() => {
    setState(dashboard.state());
    return dashboard.subscribe(() => setState(dashboard.state()));
  }, [dashboard]);
  return state;
}

/** The time, kept current, so that "12s ago" counts up while nothing else changes. */
export function useNow(everyMs = 1000): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(timer);
  }, [everyMs]);
  return now;
}

/** Where the browser keeps which projects are hidden: their `owner/name`, as a JSON list. A preference, nothing more. */
export const HIDDEN_PROJECTS_KEY = "github-dashboard:hidden-projects";

/** The projects hidden in this browser, as kept: for what isn't drawn from `useHiddenProjects`, such as notifications. */
export function readHidden(): Set<string> {
  try {
    const kept: unknown = JSON.parse(localStorage.getItem(HIDDEN_PROJECTS_KEY) ?? "[]");
    return new Set(Array.isArray(kept) ? kept.filter((one): one is string => typeof one === "string") : []);
  } catch {
    // No storage (a private window, say), or something else's text under the key: nothing is hidden.
    return new Set();
  }
}

/**
 * The projects the user has hidden, remembered in this browser, and how to hide or show one. Where the browser won't
 * keep it, it lasts as long as the page.
 */
export function useHiddenProjects(): { hidden: ReadonlySet<string>; toggle: (repo: string) => void } {
  const [hidden, setHidden] = useState(readHidden);
  const toggle = useCallback((repo: string) => {
    setHidden((was) => {
      const next = new Set(was);
      if (!next.delete(repo)) {
        next.add(repo);
      }
      try {
        localStorage.setItem(HIDDEN_PROJECTS_KEY, JSON.stringify([...next].sort()));
      } catch {
        // Not kept, then; it still holds for this page.
      }
      return next;
    });
  }, []);
  return { hidden, toggle };
}
