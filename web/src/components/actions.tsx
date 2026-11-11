import { createContext } from "preact";
import { useContext } from "preact/hooks";
import type { RunActions } from "../model.ts";

/**
 * What the page can do, besides showing. Each part is optional: a component whose part is missing draws no buttons
 * for it, so without any the dashboard is read-only. The real ones act on GitHub; the demo brings its own.
 */
export type Actions = {
  /** On release runs and projects. */
  runs?: RunActions;
};

export const ActionsContext = createContext<Actions | undefined>(undefined);

/** The page's actions, or undefined where it only shows. */
export function useActions(): Actions | undefined {
  return useContext(ActionsContext);
}
