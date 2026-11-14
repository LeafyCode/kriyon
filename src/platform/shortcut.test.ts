import { describe, expect, it } from "vitest";
import { TOUR_STEPS } from "../tour/steps.ts";
import { platformCopy, platformKeys, shortcutLabel } from "./shortcut.ts";

describe("shortcutLabel", () => {
  it("keeps the mac glyphs on mac", () => {
    expect(shortcutLabel("⌘⇧P", true)).toBe("⌘⇧P");
  });

  it("spells the chord out with Ctrl elsewhere", () => {
    expect(shortcutLabel("⌘⇧P", false)).toBe("Ctrl+Shift+P");
    expect(shortcutLabel("⌘K", false)).toBe("Ctrl+K");
    expect(shortcutLabel("⌘,", false)).toBe("Ctrl+,");
    expect(shortcutLabel("⌘⌫", false)).toBe("Ctrl+Backspace");
    expect(shortcutLabel("⌘⌥I", false)).toBe("Ctrl+Alt+I");
  });

  it("rewrites every chord inside a longer label", () => {
    expect(shortcutLabel("Settings (⌘,)", false)).toBe("Settings (Ctrl+,)");
    expect(
      shortcutLabel("Enter insert · ⌘F favourite · ⌘⌫ delete", false)
    ).toBe("Enter insert · Ctrl+F favourite · Ctrl+Backspace delete");
  });
});

describe("platformCopy and platformKeys", () => {
  it("leave mac copy as written", () => {
    expect(
      platformCopy("A look.{mac: Also in Help → Kriyon Tour.}", true)
    ).toBe("A look. Also in Help → Kriyon Tour.");
    expect(platformKeys(["⌘N", "⌘K"], true)).toEqual(["⌘N", "⌘K"]);
  });

  it("drop the Help menu and menu-bar shortcuts elsewhere", () => {
    expect(
      platformCopy(
        "Take this tour again any time from {mac:Help → Kriyon Tour, }the command palette or Settings.",
        false
      )
    ).toBe(
      "Take this tour again any time from the command palette or Settings."
    );
    expect(
      platformCopy(
        "A one-minute look.{mac: Also in Help → Kriyon Tour.}",
        false
      )
    ).toBe("A one-minute look.");
    expect(platformCopy("⌘⇧N adds one from anywhere.", false)).toBe(
      "Ctrl+Shift+N adds one from anywhere."
    );
    expect(platformKeys(["⌘N"], false)).toEqual([]);
    expect(platformKeys(["⌘K", "⌘,"], false)).toEqual(["Ctrl+K", "Ctrl+,"]);
  });
});

/** What only the macOS menu bar makes true. */
const MENU_BAR_MENTION = /Help →|menu bar/;

describe("Mac-only copy", () => {
  it("is marked wherever the tour names the menu bar, so Windows never reads it", () => {
    for (const step of TOUR_STEPS) {
      expect(platformCopy(step.body, false)).not.toMatch(MENU_BAR_MENTION);
    }
  });
});
