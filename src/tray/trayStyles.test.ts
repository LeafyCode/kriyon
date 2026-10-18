import { describe, expect, it } from "vitest";
// Read as text through Vite's `?raw`. Only TS/TSX sources can be read this
// way here: Vitest runs with `css: false`, so a `*.css?raw` import comes back
// as the empty string and a stylesheet's *contents* are not assertable. What
// is assertable — and what actually broke — is which sheet each entry point
// pulls in, plus which classes the tray's markup names.
import trayEntry from "./main.tsx?raw";
import trayPanel from "./TrayPanel.tsx?raw";

/**
 * The tray popover is its own document (`tray.html`), and it deliberately does
 * **not** load `App.css` — it locks scrolling and hides its scrollbars on its
 * own terms, and the main window's stylesheet is far more than it needs.
 *
 * That makes a `kr-*` className in `TrayPanel` a promise the tray document has
 * to keep by itself, and it did not: seven hover classes shipped naming rules
 * that lived only in a stylesheet this document never loads, so every one of
 * them was inert in the popover. The fix put that family in `hover.css` and
 * gave both documents an import of it.
 */

/** Every `className="…"` in a source file. */
const CLASS_NAMES = /className="([^"]+)"/g;
/** The whitespace a `className` splits its names on. */
const WHITESPACE = /\s+/;
/** The tray entry's import of the shared sheet. */
const TRAY_IMPORT = /import\s+"\.\.\/hover\.css"/;
/** An *import* of the main window's stylesheet, which the tray must not pull
 *  in. Matched as an import rather than a bare mention, since the entry's own
 *  comment names `App.css` to explain why it does not import it. */
const APP_STYLESHEET_IMPORT = /import\s+"[^"]*App\.css"/;

/**
 * The `kr-*` classes `hover.css` defines. Kept here by hand because the sheet
 * itself is unreadable under `css: false` — so this is a list to update when
 * `hover.css` gains a rule, and the test below is what catches the realistic
 * mistake: a new `kr-` class reaching `TrayPanel` that the shared sheet has no
 * rule for, and which would therefore be inert in the popover exactly as the
 * original seven were.
 */
const SHARED_SHEET_CLASSES = ["kr-hover-accent", "kr-hover-surface", "kr-row"];

/** Every `kr-*` class the tray's markup names. */
function trayClasses(): string[] {
  const found = new Set<string>();
  for (const match of trayPanel.matchAll(CLASS_NAMES)) {
    for (const name of match[1].split(WHITESPACE)) {
      if (name.startsWith("kr-")) {
        found.add(name);
      }
    }
  }
  return [...found].sort();
}

describe("the tray's stylesheet", () => {
  it("names only classes the shared sheet defines", () => {
    const classes = trayClasses();
    expect(classes.length).toBeGreaterThan(0);
    for (const name of classes) {
      expect(
        SHARED_SHEET_CLASSES,
        `${name} is named by TrayPanel — add its rule to hover.css`
      ).toContain(name);
    }
  });

  it("is actually imported by the tray entry point", () => {
    // The regression itself: without this import the rules exist and still
    // never reach the popover.
    expect(trayEntry).toMatch(TRAY_IMPORT);
  });

  it("does not drag in the main window's stylesheet to get them", () => {
    // Importing `App.css` here would "fix" the hovers and undo the reason the
    // tray is a separate document.
    expect(trayEntry).not.toMatch(APP_STYLESHEET_IMPORT);
  });
});
