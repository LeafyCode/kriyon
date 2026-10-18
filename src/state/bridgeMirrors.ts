import {
  setAutoSleep,
  setFocusedSession,
  setMemoryBudget,
  setNotifyPreference,
  setNotifySound,
} from "../ipc/bridge.ts";
import { AUTO_SLEEP_SECS, useLayout } from "./layout.ts";
import { mirrorToBridge } from "./mirrorToBridge.ts";
import { useSessions } from "./sessions.ts";

/**
 * Install every "mirror a store field to a backend bridge call" case in one
 * place. Each case is a [`mirrorToBridge`] registration — the module owns the
 * subscribe/diff/teardown; this only lists what to mirror where:
 *
 * - the store's active session → the backend's notion of the on-screen session
 *   (combined with the native window-focus state to suppress redundant OS
 *   notifications: only when the window is focused *and* this is that session);
 * - the layout's [Notify preference] → the backend's cross-project notify gate
 *   (layered on the per-transition decision so the user can mute all, or only
 *   hear about blocked sessions);
 * - the layout's [notify sound] → the backend's chosen OS-notification sound,
 *   attached to future notifications.
 *
 * Returns one teardown that unsubscribes every mirror.
 */
export function installBridgeMirrors(): () => void {
  const stops = [
    mirrorToBridge(
      useSessions,
      (state) => state.activeSessionId,
      setFocusedSession
    ),
    mirrorToBridge(
      useLayout,
      (state) => state.layout.notifyPreference,
      setNotifyPreference
    ),
    mirrorToBridge(
      useLayout,
      (state) => state.layout.notifySound,
      setNotifySound
    ),
    // The budget is two fields behind one backend call; mirroring each field
    // separately keeps mirrorToBridge's reference-compare exact (a combined
    // object selector would allocate fresh on every state change). Each push
    // reads the sibling field's current value from the store.
    mirrorToBridge(
      useLayout,
      (state) => state.layout.memoryBudgetMb,
      (budgetMb) =>
        setMemoryBudget(budgetMb, useLayout.getState().layout.memoryWarnEnabled)
    ),
    mirrorToBridge(
      useLayout,
      (state) => state.layout.memoryWarnEnabled,
      (warnEnabled) =>
        setMemoryBudget(useLayout.getState().layout.memoryBudgetMb, warnEnabled)
    ),
    mirrorToBridge(
      useLayout,
      (state) => state.layout.autoSleepAfter,
      (after) =>
        after === "off"
          ? setAutoSleep(false, AUTO_SLEEP_SECS["3h"])
          : setAutoSleep(true, AUTO_SLEEP_SECS[after])
    ),
  ];
  return () => {
    for (const stop of stops) {
      stop();
    }
  };
}
