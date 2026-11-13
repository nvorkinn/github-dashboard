/**
 * Light, dark, or whatever the system is set to. The colours are all `light-dark()` pairs, so the choice is only the
 * root's `color-scheme`: "auto" leaves it at `light dark`, which follows the system setting live, and the others pin it.
 */
export type Theme = "auto" | "light" | "dark";

export const THEMES: { value: Theme; label: string }[] = [
  { value: "auto", label: "Auto, following the system setting" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

// A preference, not a secret: fine to keep in the browser.
const THEME_KEY = "github-dashboard:theme";

export function rememberedTheme(): Theme {
  try {
    const stored = localStorage.getItem(THEME_KEY);
    return THEMES.find((theme) => theme.value === stored)?.value ?? "auto";
  } catch {
    // Storage can be switched off; the default will do.
    return "auto";
  }
}

/** Shows the page in the theme. "auto" takes the attribute off, so the stylesheet's `light dark` applies. */
export function applyTheme(theme: Theme, root: HTMLElement = document.documentElement): void {
  if (theme === "auto") {
    delete root.dataset.theme;
  } else {
    root.dataset.theme = theme;
  }
}

/** Shows the page in the theme and remembers it for next time. */
export function chooseTheme(theme: Theme): void {
  applyTheme(theme);
  try {
    if (theme === "auto") {
      localStorage.removeItem(THEME_KEY);
    } else {
      localStorage.setItem(THEME_KEY, theme);
    }
  } catch {
    // Not remembered, then.
  }
}
