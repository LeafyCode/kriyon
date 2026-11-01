const MAC_PLATFORM = /mac/i;
const MAC_AGENT = /mac os x/i;
const WINDOWS_AGENT = /windows/i;

/**
 * Whether this frontend runs on macOS. On mac, ⌘ carries app chords and Ctrl
 * belongs to the shell (Ctrl+C interrupt, Ctrl+K kill-line, Ctrl+A/E
 * movement); elsewhere Ctrl stands in for ⌘.
 */
export function isMacPlatform(): boolean {
  if (typeof navigator === "undefined") {
    return false;
  }
  return (
    MAC_PLATFORM.test(navigator.platform ?? "") ||
    MAC_AGENT.test(navigator.userAgent ?? "")
  );
}

/**
 * Whether this frontend runs on Windows, where a session's shell is
 * PowerShell rather than a POSIX shell.
 */
export function isWindowsPlatform(): boolean {
  if (typeof navigator === "undefined") {
    return false;
  }
  return WINDOWS_AGENT.test(navigator.userAgent ?? "");
}
