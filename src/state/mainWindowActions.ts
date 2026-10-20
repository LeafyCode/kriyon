import { onNewSession, onOpenPreferences, onShowAbout } from "../ipc/bridge.ts";
import { onEvent, stopAll } from "../ipc/onEvent.ts";
import { startNewSession } from "./actions.ts";
import { useLayout } from "./layout.ts";
import { useUi } from "./ui.ts";

/**
 * Wire the tray's + app menu's Rust-emitted intents to the same actions the
 * main window's own controls run: "new-session" is the sidebar's New session
 * (pick a folder, open a session there); "open-preferences" is ⌘, (the
 * Settings view); "show-about" is the About panel. Returns a cleanup fn.
 */
export function installMainWindowActions(): () => void {
  return stopAll([
    onEvent(onNewSession, () => {
      startNewSession();
    }),
    onEvent(onOpenPreferences, () => useLayout.getState().setView("settings")),
    onEvent(onShowAbout, () => useUi.getState().openAbout()),
  ]);
}
