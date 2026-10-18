interface ChordEvent {
  altKey: boolean;
  ctrlKey: boolean;
  isComposing: boolean;
  key: string;
  metaKey: boolean;
  shiftKey: boolean;
  type: string;
}

const MAC_PLATFORM = /mac/i;
const MAC_AGENT = /mac os x/i;

/**
 * Whether this frontend runs on macOS. On mac, ⌘ carries app chords and Ctrl
 * belongs to the shell (Ctrl+C interrupt, Ctrl+K kill-line, Ctrl+A/E movement);
 * elsewhere Ctrl stands in for ⌘. Every chord predicate below branches on this,
 * with the platform injectable for tests.
 */
function isMacPlatform(): boolean {
  if (typeof navigator === "undefined") {
    return false;
  }
  return (
    MAC_PLATFORM.test(navigator.platform ?? "") ||
    MAC_AGENT.test(navigator.userAgent ?? "")
  );
}

/** The chord's app-modifier: ⌘ on mac, Ctrl elsewhere — never both. */
function appModifier(event: ChordEvent, mac: boolean): boolean {
  return mac ? event.metaKey : event.ctrlKey;
}

/**
 * App-reserved chords that must reach the global `window` keydown listeners
 * (⌘⇧P Prompt picker, ⌘K Command palette, ⌘⇧K Needs-you) rather than be
 * intercepted by a focused xterm. The terminal's custom key handler returns
 * `false` for these so xterm ignores the event entirely and it propagates —
 * fixing the "⌘⇧P doesn't open while a terminal is focused" report.
 *
 * Only the platform's app-modifier is reserved: on mac the Ctrl variants stay
 * with the shell (Ctrl+K is kill-to-end-of-line, not the palette).
 */
export function isReservedAppChord(
  event: ChordEvent,
  mac: boolean = isMacPlatform()
): boolean {
  if (event.type !== "keydown") {
    return false;
  }
  if (!appModifier(event, mac)) {
    return false;
  }
  const key = event.key.toLowerCase();
  // ⌘K / ⌘⇧K — palette and Needs-you.
  if (key === "k") {
    return true;
  }
  // ⌘⇧P — Prompt picker (bare ⌘P is not reserved).
  return key === "p" && event.shiftKey;
}

/**
 * The clean-copy chord (used only while a selection is live): ⌘C on mac, Ctrl+C
 * elsewhere (the Windows Terminal convention). On mac Ctrl+C is deliberately
 * NOT a copy chord — it must always reach the shell as SIGINT, selection or not.
 */
export function isCopyChord(
  event: ChordEvent,
  mac: boolean = isMacPlatform()
): boolean {
  return (
    event.type === "keydown" &&
    appModifier(event, mac) &&
    event.key.toLowerCase() === "c"
  );
}

/**
 * Shift+Enter — "insert a newline, don't submit". xterm sends a bare CR for
 * Enter whether or not Shift is held, so a CLI that reads a multi-line prompt
 * (Claude's) can't tell the two apart and submits. Terminals solve this by
 * sending ESC CR instead: that is exactly what Claude's `/terminal-setup`
 * installs for VS Code, Alacritty and Zed, and what iTerm2/Ghostty/Kitty/WezTerm
 * send natively. The terminal sends it too — see NEWLINE_SEQUENCE.
 *
 * Bare Shift only: ⌘/Ctrl+Enter keep their own meanings, and Option+Enter
 * already reaches the app as ESC CR. An Enter that confirms an IME candidate is
 * reported as key "Enter" too — it belongs to the composition, never to us.
 */
export function isNewlineChord(event: ChordEvent): boolean {
  return (
    event.type === "keydown" &&
    event.key === "Enter" &&
    !event.isComposing &&
    event.shiftKey &&
    !(event.altKey || event.ctrlKey || event.metaKey)
  );
}

/** What a Shift+Enter is sent to the pty as: ESC CR (Meta-Return). */
export const NEWLINE_SEQUENCE = "\x1b\r";

/**
 * The Warp-style split chord: ⌘/Ctrl+D (no Shift). Only Project terminals act on
 * it (opt-in via a callback). Both modifiers split on every platform — Ctrl+D
 * as split is a deliberate product choice, matching Warp.
 */
export function isSplitChord(event: ChordEvent): boolean {
  return (
    event.type === "keydown" &&
    (event.metaKey || event.ctrlKey) &&
    !event.shiftKey &&
    event.key.toLowerCase() === "d"
  );
}
