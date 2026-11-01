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

/** The parts of the copy that name the macOS menu bar's Help menu. */
const HELP_MENU_MENTION = /Help → Kriyon Tour, | Also in Help → Kriyon Tour\./g;

/** Shortcuts that come from the macOS menu bar, which other platforms lack. */
const MENU_BAR_ONLY = new Set(["⌘N"]);

/**
 * Copy as this platform reads it: shortcuts spelled with Ctrl off macOS (see
 * {@link shortcutLabel}), and no mention of the Help menu, which only the
 * macOS menu bar has.
 */
export function platformCopy(
  text: string,
  mac: boolean = isMacPlatform()
): string {
  return mac ? text : shortcutLabel(text.replace(HELP_MENU_MENTION, ""), false);
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
