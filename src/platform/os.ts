const MAC_PLATFORM = /mac/i;
const MAC_AGENT = /mac os x/i;

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

/** How the copy names the person's computer: "this Mac" on macOS, "this PC"
 * on Windows. */
export function thisComputer(): string {
  return isMacPlatform() ? "this Mac" : "this PC";
}

/** The platform's file manager, for "Reveal in …": Finder or File Explorer. */
export function fileManagerName(): string {
  return isMacPlatform() ? "Finder" : "File Explorer";
}
