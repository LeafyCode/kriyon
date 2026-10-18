import { emit } from "@tauri-apps/api/event";
import { isTauriRuntime } from "../ipc/bridge.ts";
import { useLayout } from "./layout.ts";

/**
 * Broadcast the menu-bar mode and the active theme to the tray window whenever
 * either changes, so a live popover re-lays-out / re-themes immediately.
 * Cross-window `emit` reaches every window.
 */
export function installMenuBarModeSync(): () => void {
  if (!isTauriRuntime()) {
    return () => undefined;
  }
  let prevMode = useLayout.getState().layout.menuBarMode;
  let prevTheme = useLayout.getState().layout.themeId;
  return useLayout.subscribe((state) => {
    const nextMode = state.layout.menuBarMode;
    if (nextMode !== prevMode) {
      prevMode = nextMode;
      emit("menu-bar-mode", nextMode).catch(() => undefined);
    }
    const nextTheme = state.layout.themeId;
    if (nextTheme !== prevTheme) {
      prevTheme = nextTheme;
      emit("menu-bar-theme", nextTheme).catch(() => undefined);
    }
  });
}
