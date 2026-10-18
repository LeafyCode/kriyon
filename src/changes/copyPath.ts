import { copyText } from "../ui/copyText.ts";

/**
 * "Copy this file path to the clipboard", with a confirmation toast either
 * way. Shared by every place a path gets copied — the diff feed's file card,
 * the Inspector's changed-files list, and the file tree's context menu — so
 * the copy behaviour can't drift between them.
 */
export function copyPath(path: string): void {
  copyText(path, "path");
}
