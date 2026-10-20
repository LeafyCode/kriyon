import { describe, expect, test, vi } from "vitest";

const { startNewSession } = vi.hoisted(() => ({
  startNewSession: vi.fn(() => Promise.resolve()),
}));
vi.mock("./actions.ts", () => ({ startNewSession }));

vi.mock("../ipc/bridge.ts", () => ({
  onNewSession: (cb: () => void) => {
    (globalThis as Record<string, unknown>).__fireNewSession = cb;
    return Promise.resolve(() => undefined);
  },
  onOpenPreferences: (cb: () => void) => {
    (globalThis as Record<string, unknown>).__fireOpenPreferences = cb;
    return Promise.resolve(() => undefined);
  },
  onShowAbout: (cb: () => void) => {
    (globalThis as Record<string, unknown>).__fireShowAbout = cb;
    return Promise.resolve(() => undefined);
  },
}));

describe("installMainWindowActions", () => {
  // The tray's "New session" and the sidebar's must be the same flow. The spawn dialog
  // is not it: with no predecessor and no project it has nothing to anchor
  // to, so it renders nothing and the click looks dead.
  test("a new-session event starts a new session, as the sidebar button does", async () => {
    const { useUi } = await import("./ui.ts");
    const { installMainWindowActions } = await import("./mainWindowActions.ts");
    installMainWindowActions();
    await Promise.resolve();
    (globalThis as unknown as Record<string, () => void>).__fireNewSession();
    expect(startNewSession).toHaveBeenCalledTimes(1);
    expect(useUi.getState().spawnOpen).toBe(false);
  });

  // The tray's gear and "Preferences" item must land where ⌘, and the
  // sidebar's gear do: the Settings view, which is where menu-bar mode lives.
  test("an open-preferences event opens the Settings view", async () => {
    const { useLayout } = await import("./layout.ts");
    const { useUi } = await import("./ui.ts");
    const { installMainWindowActions } = await import("./mainWindowActions.ts");
    installMainWindowActions();
    await Promise.resolve();
    (
      globalThis as unknown as Record<string, () => void>
    ).__fireOpenPreferences();
    expect(useLayout.getState().layout.view).toBe("settings");
    expect(useUi.getState().paletteOpen).toBe(false);
  });

  test("a show-about event opens the About panel", async () => {
    const { useUi } = await import("./ui.ts");
    const { installMainWindowActions } = await import("./mainWindowActions.ts");
    installMainWindowActions();
    await Promise.resolve();
    (globalThis as unknown as Record<string, () => void>).__fireShowAbout();
    expect(useUi.getState().aboutOpen).toBe(true);
  });
});
