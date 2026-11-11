import { useEffect, useState } from "preact/hooks";
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
