/**
 * Light or dark. With nothing stored the page follows the system; picking one
 * in the nav pins it (`data-theme` on `<html>`, remembered in localStorage).
 * The CSS reads `data-theme` first and `prefers-color-scheme` second.
 */
export type Theme = "light" | "dark";

export const THEME_KEY = "kriyon-theme";

/**
 * Runs in `<head>` before first paint, so a pinned dark page never flashes
 * white. Storage can throw (private windows, blocked site data): then the
 * system setting stands. It also marks `<html>` with `js`, which the CSS uses
 * to hold scroll-triggered art at its first frame; without scripts the page
 * shows that art finished.
 */
export const THEME_SCRIPT = `document.documentElement.classList.add("js");try{var t=localStorage.getItem("${THEME_KEY}");if(t==="light"||t==="dark")document.documentElement.dataset.theme=t}catch(e){}`;

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
  document.documentElement.dataset.theme = theme;
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    // Not remembered across visits; this page still switches.
  }
}
