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

/**
 * Copy that only the macOS menu bar makes true, marked where it is written as
 * `{mac:…}` — "Also in Help → Kriyon Tour." names a menu other platforms lack.
 */
const MAC_ONLY = /\{mac:([^}]*)\}/g;

/** Shortcuts that come from the macOS menu bar, which other platforms lack. */
const MENU_BAR_ONLY = new Set(["⌘N"]);

/**
 * Copy as this platform reads it: the `{mac:…}` parts kept on macOS and
 * dropped elsewhere, and shortcuts spelled with Ctrl off macOS (see
 * {@link shortcutLabel}).
 */
export function platformCopy(
  text: string,
  mac: boolean = isMacPlatform()
): string {
  return mac
    ? text.replace(MAC_ONLY, "$1")
    : shortcutLabel(text.replace(MAC_ONLY, ""), false);
}

/**
 * The shortcut keys worth showing on this platform, as it spells them. A
 * shortcut only the macOS menu bar provides (⌘N) is left out elsewhere.
 */
export function platformKeys(
  keys: readonly string[],
  mac: boolean = isMacPlatform()
): string[] {
  return mac
    ? [...keys]
    : keys
        .filter((key) => !MENU_BAR_ONLY.has(key))
        .map((key) => shortcutLabel(key, false));
}

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
