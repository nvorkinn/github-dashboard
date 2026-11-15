/** How much of a split diff the "before" side takes, once the divider between the two sides has been dragged. */

/** Neither side gets narrower than this share, so both stay readable. */
export const MIN_SPLIT_SHARE = 0.15;
export const MAX_SPLIT_SHARE = 1 - MIN_SPLIT_SHARE;

// A preference, not a secret: fine to keep in the browser, like the theme.
const SPLIT_SHARE_KEY = "github-dashboard:review-split";

/** The share within what keeps both sides readable, to a tenth of a percent. */
export function clampSplitShare(share: number): number {
  const kept = Math.min(Math.max(share, MIN_SPLIT_SHARE), MAX_SPLIT_SHARE);
  return Math.round(kept * 1000) / 1000;
}

/** The chosen share, or nothing when the sides keep their even halves. */
export function rememberedSplitShare(): number | undefined {
  try {
    const stored = localStorage.getItem(SPLIT_SHARE_KEY);
    const share = Number(stored);
    return stored !== null && share >= MIN_SPLIT_SHARE && share <= MAX_SPLIT_SHARE ? share : undefined;
  } catch {
    // Storage can be switched off; even halves will do.
    return undefined;
  }
}

/** Remembers the share for next time, or forgets it when the sides go back to halves. */
export function rememberSplitShare(share: number | undefined): void {
  try {
    if (share === undefined) {
      localStorage.removeItem(SPLIT_SHARE_KEY);
    } else {
      localStorage.setItem(SPLIT_SHARE_KEY, String(share));
    }
  } catch {
    // Not remembered, then.
  }
}
