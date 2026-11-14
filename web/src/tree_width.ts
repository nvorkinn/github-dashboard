/** How wide the review overlay draws its file tree, in pixels, once the divider has been dragged. */

/** Narrower than this and file names stop being readable. */
export const MIN_TREE_WIDTH = 180;

/** The share of the overlay the tree may take, so that the diff always keeps most of it. */
export const MAX_TREE_SHARE = 0.6;

// A preference, not a secret: fine to keep in the browser, like the theme.
const TREE_WIDTH_KEY = "github-dashboard:review-tree-width";

/** The width within what the overlay, `available` pixels wide, can give the tree. */
export function clampTreeWidth(width: number, available: number): number {
  return Math.round(Math.min(Math.max(width, MIN_TREE_WIDTH), Math.max(MIN_TREE_WIDTH, available * MAX_TREE_SHARE)));
}

/** The chosen width, or nothing when the tree keeps the width the stylesheet gives it. */
export function rememberedTreeWidth(): number | undefined {
  try {
    const stored = Number(localStorage.getItem(TREE_WIDTH_KEY));
    return Number.isFinite(stored) && stored >= MIN_TREE_WIDTH ? stored : undefined;
  } catch {
    // Storage can be switched off; the default will do.
    return undefined;
  }
}

/** Remembers the width for next time, or forgets it when there is none. */
export function rememberTreeWidth(width: number | undefined): void {
  try {
    if (width === undefined) {
      localStorage.removeItem(TREE_WIDTH_KEY);
    } else {
      localStorage.setItem(TREE_WIDTH_KEY, String(width));
    }
  } catch {
    // Not remembered, then.
  }
}
