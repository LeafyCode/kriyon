// Just the faces and the hover family, not the whole of `App.css`: this
// document locks scrolling and hides its scrollbars on its own terms (see
// `tray.html`). `hover.css` is not optional — every `kr-hover-*` className in
// `TrayPanel` names a rule that lives there, and without this import they are
// all inert in the popover.
import "../fonts.css";
import "../hover.css";
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  isTauriRuntime,
  loadLayout,
  newSession,
  onMenuBarMode,
  onMenuBarTheme,
  onTrayVisibility,
  openPreferences,
  revealSession,
  type SessionSnapshotRow,
  sessionSnapshots,
  showMainWindow,
} from "../ipc/bridge.ts";
import { onEvent, stopAll } from "../ipc/onEvent.ts";
import { applyTheme } from "../theme/applyTheme.ts";
import { themeById } from "../theme/themes/index.ts";
import { snapshotGroups } from "./snapshotGroups.ts";
import TrayPanel from "./TrayPanel.tsx";

applyTheme(themeById(undefined));

/** The persisted-layout key the main window saves under (see `persistence.ts`). */
const LAYOUT_KEY = "layout";

/** How often the popover re-polls the backend for live session state. */
const POLL_MS = 2000;

/**
 * Read the persisted layout blob once at startup to seed the popover's mode
 * and theme before the first live `menu-bar-mode` broadcast arrives. Any
 * failure (no Tauri runtime, malformed JSON) falls back to the same default
 * the main window starts from.
 */
function readMode(): Promise<"compact" | "grouped"> {
  return loadLayout(LAYOUT_KEY)
    .then((json) => {
      if (!json) {
        return "grouped" as const;
      }
      const parsed = JSON.parse(json) as {
        menuBarMode?: unknown;
        themeId?: unknown;
      };
      if (typeof parsed.themeId === "string") {
        applyTheme(themeById(parsed.themeId));
      }
      return parsed.menuBarMode === "compact" ? "compact" : "grouped";
    })
    .catch(() => "grouped" as const);
}

function TrayApp() {
  const [mode, setMode] = useState<"compact" | "grouped">("grouped");
  const [nowMs, setNowMs] = useState(0);
  const [snaps, setSnaps] = useState<SessionSnapshotRow[]>([]);
  const [memoryTotalMb, setMemoryTotalMb] = useState(0);
  const [cpuTotalPct, setCpuTotalPct] = useState<number | null>(null);
  const [degraded, setDegraded] = useState(false);

  useEffect(() => {
    if (!isTauriRuntime()) {
      return;
    }
    // The tray is a read-only glance: poll the backend for the current live
    // session state and render straight from it. This avoids depending on a
    // pre-seeded store or on catching the session-status event stream from the
    // moment a session changes (a hidden webview can miss those).
    //
    // Polling is gated on the backend's `tray-visibility` broadcast (driven by
    // the panel's native focus event), so it only hits the backend while the
    // popover is actually on screen instead of every 2s for the app's whole
    // lifetime — and, unlike the webview's own focus event, that signal fires
    // reliably, so a fresh poll always runs the moment the popover opens. A
    // persistent poll failure flips a degraded flag so an empty list is shown
    // honestly rather than as a misleading "no sessions running".
    let alive = true;
    let pollTimer: ReturnType<typeof setInterval> | undefined;
    const poll = () => {
      sessionSnapshots()
        .then((snapshot) => {
          if (alive) {
            setSnaps(snapshot.sessions);
            setMemoryTotalMb(snapshot.totalMemoryMb);
            setCpuTotalPct(snapshot.totalCpuPct);
            setNowMs(Date.now());
            setDegraded(false);
          }
        })
        .catch(() => {
          if (alive) {
            setDegraded(true);
          }
        });
    };
    const startPolling = () => {
      if (pollTimer === undefined) {
        poll();
        pollTimer = setInterval(poll, POLL_MS);
      }
    };
    const stopPolling = () => {
      if (pollTimer !== undefined) {
        clearInterval(pollTimer);
        pollTimer = undefined;
      }
    };
    // One poll on mount so a first open paints immediately; the visibility
    // listener then drives the live interval only while the popover is shown.
    poll();

    readMode().then(setMode);
    const stopListeners = stopAll([
      onEvent(onMenuBarMode, setMode),
      onEvent(onMenuBarTheme, (id) => applyTheme(themeById(id))),
      onEvent(onTrayVisibility, (visible) => {
        if (visible) {
          startPolling();
        } else {
          stopPolling();
        }
      }),
    ]);
    return () => {
      alive = false;
      stopPolling();
      stopListeners();
    };
  }, []);

  const groups = snapshotGroups(snaps, nowMs);
  return (
    <TrayPanel
      cpuTotalPct={cpuTotalPct}
      degraded={degraded}
      groups={groups}
      memoryTotalMb={memoryTotalMb}
      mode={mode}
      onNewSession={() => {
        newSession().catch(() => undefined);
      }}
      onOpenApp={() => {
        showMainWindow().catch(() => undefined);
      }}
      onOpenSession={(id) => {
        revealSession(id).catch(() => undefined);
      }}
      onPreferences={() => {
        openPreferences().catch(() => undefined);
      }}
    />
  );
}

const root = document.getElementById("tray-root");
if (root) {
  createRoot(root).render(<TrayApp />);
}
