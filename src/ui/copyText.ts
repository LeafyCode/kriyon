import { showToast } from "./Toast.tsx";

/**
 * Copy `text` to the clipboard with a toast either way — a click is an
 * explicit ask, so a silent failure would read as the copy having worked.
 * `navigator.clipboard` is undefined outside a secure context, and that
 * property access happens before any promise exists, so the guard (not a
 * `.catch()`) keeps it from throwing out of a click handler.
 */
export function copyText(text: string, what = "text"): void {
  if (!navigator.clipboard) {
    showToast(`Could not copy the ${what}`, "error");
    return;
  }
  navigator.clipboard
    .writeText(text)
    .then(() => showToast("Copied"))
    .catch(() => showToast(`Could not copy the ${what}`, "error"));
}
