import { isMacPlatform } from "./os.ts";

const MODIFIER_NAMES: Record<string, string> = {
  "⌘": "Ctrl",
  "⇧": "Shift",
  "⌥": "Alt",
  "⌃": "Ctrl",
};

const KEY_NAMES: Record<string, string> = {
  "⌫": "Backspace",
  "↩": "Enter",
  "⎋": "Esc",
};

/** One run of mac modifier glyphs followed by the key they modify. */
const CHORD = /([⌘⇧⌥⌃]+)(\S)/gu;

/**
 * A shortcut label as this platform writes it. Labels are written the mac way
 * (`⌘⇧P`); elsewhere every chord in the text is spelled out with Ctrl standing
 * in for ⌘ (`Ctrl+Shift+P`), which is the key the app listens for there.
 */
export function shortcutLabel(
  label: string,
  mac: boolean = isMacPlatform()
): string {
  if (mac) {
    return label;
  }
  return label.replace(CHORD, (_, modifiers: string, key: string) => {
    const names = [...modifiers].map((m) => MODIFIER_NAMES[m] ?? m);
    return [...names, KEY_NAMES[key] ?? key].join("+");
  });
}
