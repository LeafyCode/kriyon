/**
 * Light or dark. With nothing stored the page follows the system; picking one
 * in the nav pins it (`data-theme` on `<html>`, remembered in localStorage).
 * The CSS reads `data-theme` first and `prefers-color-scheme` second.
 */
export type Theme = "light" | "dark";

export const THEME_KEY = "kriyon-theme";

/** The browser bar colour per theme: each theme's `--ground` in styles.css. */
export const THEME_COLORS: Readonly<Record<Theme, string>> = {
  light: "#ffffff",
  dark: "#0d1017",
};

/**
 * Puts a pinned theme on the page: `data-theme` for the CSS, and a
 * `theme-color` tag of its own, first in `<head>` and with no media query, so
 * the browser bar follows the pin rather than the system. It never edits the
 * two tags React renders: React would see the changed content on hydration
 * and add a fresh copy beside them. Self-contained, because `THEME_SCRIPT`
 * runs its source text as is.
 */
function applyTheme(theme: Theme, colors: Readonly<Record<Theme, string>>) {
  document.documentElement.dataset.theme = theme;
  let pinned = document.querySelector<HTMLMetaElement>(
    "meta[data-pinned-theme]"
  );
  if (!pinned) {
    pinned = document.createElement("meta");
    pinned.name = "theme-color";
    pinned.setAttribute("data-pinned-theme", "");
  }
  pinned.content = colors[theme];
  // Always (re)placed first: the browser uses the first tag that applies.
  document.head.prepend(pinned);
}

/** Self-contained for the same reason as `applyTheme`. */
function restoreTheme(
  key: string,
  colors: Readonly<Record<Theme, string>>,
  apply: typeof applyTheme
) {
  document.documentElement.classList.add("js");
  try {
    const stored = localStorage.getItem(key);
    if (stored === "light" || stored === "dark") {
      apply(stored, colors);
    }
  } catch {
    // Storage blocked (private window, site data off): the system theme stands.
  }
}

/**
 * Runs in `<head>` before first paint, so a pinned dark page never flashes
 * white. It also marks `<html>` with `js`,
 * which the CSS uses to hold scroll-triggered art at its first frame; without
 * scripts the page shows that art finished.
 */
export const THEME_SCRIPT = `(${restoreTheme.toString()})(${JSON.stringify(THEME_KEY)},${JSON.stringify(THEME_COLORS)},${applyTheme.toString()})`;

export function currentTheme(): Theme {
  const pinned = document.documentElement.dataset.theme;
  if (pinned === "light" || pinned === "dark") {
    return pinned;
  }
  return window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

export function pinTheme(theme: Theme) {
  applyTheme(theme, THEME_COLORS);
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    // Not remembered across visits; this page still switches.
  }
}

/**
 * Puts a pinned theme's bar colour back in front once React has hydrated:
 * in development React moves the tags it renders to the front of `<head>`.
 * The root document calls this once it has hydrated, on every page.
 */
export function reapplyPinnedTheme() {
  const pinned = document.documentElement.dataset.theme;
  if (pinned === "light" || pinned === "dark") {
    applyTheme(pinned, THEME_COLORS);
  }
}
