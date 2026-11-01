import { describe, expect, it } from "vitest";
import { shortcutLabel } from "./shortcut.ts";

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
