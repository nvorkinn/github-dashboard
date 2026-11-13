/** How big the review overlay draws code. "large" is the size it always had; "medium" suits most screens. */
export type DiffFontSize = "small" | "medium" | "large";

export const DIFF_FONT_SIZES: { value: DiffFontSize; label: string }[] = [
  { value: "small", label: "Small" },
  { value: "medium", label: "Medium" },
  { value: "large", label: "Large" },
];

export const DEFAULT_DIFF_FONT_SIZE: DiffFontSize = "medium";

// A preference, not a secret: fine to keep in the browser, like the theme.
const DIFF_FONT_KEY = "github-dashboard:diff-font-size";

export function rememberedDiffFontSize(): DiffFontSize {
  try {
    const stored = localStorage.getItem(DIFF_FONT_KEY);
    return DIFF_FONT_SIZES.find((size) => size.value === stored)?.value ?? DEFAULT_DIFF_FONT_SIZE;
  } catch {
    // Storage can be switched off; the default will do.
    return DEFAULT_DIFF_FONT_SIZE;
  }
}

/** Remembers the size for next time. */
export function rememberDiffFontSize(size: DiffFontSize): void {
  try {
    if (size === DEFAULT_DIFF_FONT_SIZE) {
      localStorage.removeItem(DIFF_FONT_KEY);
    } else {
      localStorage.setItem(DIFF_FONT_KEY, size);
    }
  } catch {
    // Not remembered, then.
  }
}
