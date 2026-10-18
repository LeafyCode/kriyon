import "./App.css";
import { type CSSProperties, memo, useEffect } from "react";
import { useShallow } from "zustand/react/shallow";
import { ChangesView } from "./changes/ChangesView.tsx";
import { installDomWeightWatch } from "./dev/domWeight.ts";
import {
  deleteSession,
  homeDir,
  onIntegrationRefused,
  onUpdateChanged,
  onUpdateChannelAnswered,
} from "./ipc/bridge.ts";
import { onEvent } from "./ipc/onEvent.ts";
import { Shell } from "./layout/Shell.tsx";
import {
  launchActiveSession,
  noteResumeFailed,
  restartSessionFresh,
  setDefaultCwd,
  startNewSession,
} from "./state/actions.ts";
import { installSessionListeners } from "./state/backendListeners.ts";
import { installBridgeMirrors } from "./state/bridgeMirrors.ts";
import { installCommandCenterListeners } from "./state/commandCenterListeners.ts";
import { useIntegration } from "./state/integration.ts";
import { useLayout } from "./state/layout.ts";
import { installMainWindowActions } from "./state/mainWindowActions.ts";
import { installMenuBarModeSync } from "./state/menuBarModeSync.ts";
import { hydrate, installPersistence } from "./state/persistence.ts";
import { useSessions } from "./state/sessions.ts";
import { freedMemoryNote } from "./state/stopCost.ts";
import { useTerminals } from "./state/terminals.ts";
import { useUpdates } from "./state/updates.ts";
import { useSessionWatch } from "./state/useSessionWatch.ts";
import { sessionPaneMounts } from "./state/warmPanes.ts";
import { CliDialogBar, CliDialogWaiting } from "./structured/CliDialogBar.tsx";
import { useDialogDetour } from "./structured/cliDialog.ts";
import { noteTerminalEsc } from "./structured/interrupt.ts";
import { StructuredView } from "./structured/StructuredView.tsx";
import { installCloseOnQuit } from "./terminal/closeOnQuit.ts";
import { QuitConfirmHost } from "./terminal/QuitConfirm.tsx";
import {
  disposeSession,
  setPaneBusyHandler,
  setResumeFailedHandler,
  setSessionExitedHandler,
} from "./terminal/sessionHost.ts";
import { Terminal } from "./terminal/Terminal.tsx";
import { applyTheme } from "./theme/applyTheme.ts";
import { themeById } from "./theme/themes/index.ts";
import { tokens } from "./theme/tokens.ts";
import { SessionLoadingOverlay } from "./ui/SessionLoadingOverlay.tsx";
import { SessionResumeFailedOverlay } from "./ui/SessionResumeFailedOverlay.tsx";
import { installStrayCaretGuard } from "./ui/strayCaret.ts";
import { showToast } from "./ui/Toast.tsx";
import { REFUSED_TOAST } from "./welcome/integrationCopy.ts";
import { WelcomeScreen } from "./welcome/WelcomeScreen.tsx";

function ignore(promise: Promise<unknown>): void {
  promise.catch(() => {
    // Hydration errors are non-fatal: start with an empty store.
  });
}

/**
 * Close a session end-to-end: tear down its pty + transcript watcher in the
 * backend, drop its persisted row, and remove it from the store. All keyed on
 * the same session id.
 */
function handleCloseSession(id: string): void {
  // Read before the row (and its reading) is gone.
  const freed = freedMemoryNote("Closed", useSessions.getState().memory[id]);
  disposeSession(id);
  ignore(deleteSession(id));
  useSessions.getState().removeSession(id);
  if (freed) {
    showToast(freed);
  }
}

const emptyStateStyle = {
  alignItems: "center",
  color: tokens.color.ink.muted,
  display: "flex",
  fontFamily: tokens.font.sans,
  fontSize: "13px",
  height: "100%",
  justifyContent: "center",
  padding: tokens.space.xl,
  textAlign: "center",
} as const;

/**
 * The box of a session's terminal. In the Raw view, the view itself; with the
 * Structured view, the same box (so the CLI is never resized), invisible under
 * it or over it while a [CLI dialog] is answered. Never `display: none` there:
 * a terminal never measured keeps a grid that doesn't match the CLI's, and its
 * screen can't be read (a dialog, the spinner tip) or shown as is.
 */
function terminalBoxStyle(
  raw: boolean,
  structured: boolean,
  answering: boolean
): CSSProperties {
  return {
    background: tokens.color.chrome.content,
    display: raw || structured ? "block" : "none",
    height: "100%",
    // The canvas's transcript inset: roomier at the top and sides than at the
    // bottom, where the composer's own 8px top padding continues the gap.
    padding: "20px 24px 8px",
    ...(structured
      ? {
          inset: 0,
          position: "absolute",
          visibility: answering ? "visible" : "hidden",
          zIndex: 1,
        }
      : {}),
  };
}

/**
 * One always-mounted session pane (its Terminal + Changes view), shown or
 * hidden by the active selection. Subscribes only to its own session's slices,
 * so a busy session's ticks re-render that pane alone — not every other pane
 * and not {@link App}, which only tracks the set of session ids.
 */
const SessionPane = memo(function SessionPane({
  sessionId,
}: {
  sessionId: string;
}) {
  const session = useSessions((state) => state.sessions[sessionId]);
  const isActive = useSessions((state) => state.activeSessionId === sessionId);
  // Mount the pty-backed terminal only for the active tab and any tab kept warm
  // after having been active (sessionPaneMounts). On boot that is just the
  // restored active session, so background sessions do not resume `claude` until
  // first viewed; a warm tab is never remounted (which would blank xterm) after
  // the user switches away.
  const activated = useSessions((state) =>
    sessionPaneMounts(state.activeSessionId, state.warmPanes, sessionId)
  );
  const bootPhase = useSessions(
    (state) => state.bootPhase[sessionId] ?? "idle"
  );
  const transcriptView = useLayout((state) => state.layout.transcriptView);
  const showRaw = transcriptView === "raw";
  const showChanges = transcriptView === "changes";
  const showStructured = transcriptView === "structured";
  // A dialog Claude Code opens (a question, a permission, a slash command's
  // menu) is answered in its own terminal, shown over the Structured view.
  const dialog = useDialogDetour(sessionId, isActive && showStructured);
  const showTerminal = showRaw || dialog.answering;

  // The backend watch is what feeds status, the ask, activity, usage, the
  // title and the boot-ready signal — so it follows the pane's mount, exactly
  // as it did when it hung off the (now removed) structured pane.
  useSessionWatch(sessionId, activated);

  if (!session) {
    return null;
  }

  return (
    <div
      style={{
        display: isActive ? "block" : "none",
        height: "100%",
        position: "relative",
      }}
    >
      {bootPhase === "booting" ? (
        <SessionLoadingOverlay resuming={session.claudeSessionId !== null} />
      ) : null}
      {bootPhase === "resumeFailed" ? (
        <SessionResumeFailedOverlay
          onDismiss={() =>
            useSessions.getState().applyBootEvent(sessionId, "dismissFailed")
          }
          onStartFresh={() => restartSessionFresh(sessionId)}
        />
      ) : null}
      {/* Pad the Claude output so its CLI doesn't butt against the pane edges.
          Padding lives on this wrapper (not the shared Terminal) to keep the
          Project dock terminals tight; FitAddon reads the reduced content box
          and insets the grid. The matching background makes the gap seamless. */}
      <div style={terminalBoxStyle(showRaw, showStructured, dialog.answering)}>
        {dialog.answering ? <CliDialogBar onBack={dialog.putAside} /> : null}
        {activated ? (
          <Terminal
            active={isActive && showTerminal}
            cwd={session.cwd}
            onEscape={() =>
              noteTerminalEsc(
                sessionId,
                useSessions.getState().sessions[sessionId]?.status === "running"
              )
            }
            sessionId={sessionId}
          />
        ) : null}
      </div>
      {/* Display-toggled, never conditionally unmounted *within* the warm set —
          switching back to Changes must not re-trigger the mount-refresh or
          lose the diff feed's scroll position. The keep-alive is bounded by
          `activated` (same LRU as the terminal) rather than unbounded: each
          pane holds its whole diff feed in the DOM, so mounting
          every session put 15.1M characters across 93 panes into one document
          on a real install. WebKit walks the whole document for editor state on
          every edit, which turned a single keystroke into an ~8s stall. */}
      <div style={{ display: showChanges ? "block" : "none", height: "100%" }}>
        {activated ? <ChangesView sessionId={sessionId} /> : null}
      </div>
      {/* Mounted only for the session on screen: a warm pane never carries
          the Structured view's DOM (ADR-0035). */}
      {isActive && showStructured ? (
        <div style={{ height: "100%" }}>
          <StructuredView sessionId={sessionId} />
          {dialog.waiting ? (
            <CliDialogWaiting onAnswer={dialog.answer} />
          ) : null}
        </div>
      ) : null}
    </div>
  );
});

export { SessionPane };

function App() {
  const sessionIds = useSessions(
    useShallow((state) => Object.keys(state.sessions))
  );
  const activeSessionId = useSessions((state) => state.activeSessionId);
  const themeId = useLayout((state) => state.layout.themeId);
  // Nothing starts — no session, no Claude Code change — until the welcome
  // screen's consent (the [Integration]).
  const consented = useIntegration(
    (state) => state.status?.prefs.consented === true
  );

  // Re-publish the palette whenever the choice changes (startup default,
  // hydration of the persisted choice, or the user switching themes).
  useEffect(() => {
    applyTheme(themeById(themeId));
  }, [themeId]);

  useEffect(() => {
    // Route daemon foreground-busy transitions to the terminal store. The store
    // ignores ids that aren't Project-terminal panes, so Claude sessions (always
    // "busy" while claude runs) never light the indicator.
    setPaneBusyHandler((id, busy) => {
      useTerminals.getState().setPaneBusy(id, busy);
    });
    // A dock pane's shell died underneath the app: mark it dead so the pane
    // shows "Shell exited — Restart" instead of wedging silently. The store
    // ignores non-pane ids; a Claude session heals via its activation revive.
    // The same signal tells the sessions store its claude is gone, so a turn
    // killed mid-flight stops counting as work the quit gate must warn about
    // (that store ignores non-session ids in turn).
    setSessionExitedHandler((id) => {
      useTerminals.getState().setPaneExited(id);
      useSessions.getState().noteSessionExited(id);
    });
    // A resume whose conversation expired makes Claude exit without ever starting;
    // the sessionHost watchdog detects that and we surface the recovery prompt.
    setResumeFailedHandler((id) => {
      noteResumeFailed(id);
    });
    ignore(
      homeDir().then((home) => {
        setDefaultCwd(home);
      })
    );
    ignore(useIntegration.getState().load());
    const stopIntegrationRefused = onEvent(onIntegrationRefused, (status) => {
      useIntegration.getState().replace(status);
      showToast(REFUSED_TOAST, "error");
    });
    ignore(useUpdates.getState().load());
    const stopUpdateChanged = onEvent(onUpdateChanged, (snapshot) =>
      useUpdates.getState().apply(snapshot)
    );
    const stopUpdateAnswered = onEvent(onUpdateChannelAnswered, (snapshot) =>
      useUpdates.getState().answerMove(snapshot)
    );
    ignore(hydrate());
    const stopPersistence = installPersistence();
    const stopListeners = installSessionListeners();
    const stopCommandCenter = installCommandCenterListeners();
    const stopBridgeMirrors = installBridgeMirrors();
    const stopCloseOnQuit = installCloseOnQuit();
    const stopMainWindowActions = installMainWindowActions();
    const stopMenuBarModeSync = installMenuBarModeSync();
    // A caret left in non-editable content makes WebKit rescan the whole
    // document on every rendering update, which froze the UI for as long as
    // anything kept repainting. See `strayCaret.ts` for the measured stack.
    const stopStrayCaretGuard = installStrayCaretGuard();
    // The warm-pane cap bounds how many panes mount, but the freeze was about
    // how *big* the document got — see `dev/domWeight.ts`. Dev-only.
    const stopDomWeightWatch = import.meta.env.DEV
      ? installDomWeightWatch()
      : () => {
          // Production: nothing to uninstall.
        };
    return () => {
      stopIntegrationRefused();
      stopUpdateChanged();
      stopUpdateAnswered();
      stopPersistence();
      stopListeners();
      stopCommandCenter();
      stopBridgeMirrors();
      stopCloseOnQuit();
      stopMainWindowActions();
      stopMenuBarModeSync();
      stopStrayCaretGuard();
      stopDomWeightWatch();
    };
  }, []);

  // Launch (or resume) a session the first time it is viewed — including the one
  // active on startup, which is the session the user wants restored. Resuming
  // relies on its persisted Claude session id; a brand-new session has none and
  // starts fresh. Idempotent per session, and deliberately not cancelled on
  // switch-away: the boot overlay and its timeout belong to the session, not to
  // this effect's lifetime (see launchActiveSession).
  useEffect(() => {
    if (activeSessionId && consented) {
      ignore(launchActiveSession(activeSessionId));
    }
  }, [activeSessionId, consented]);

  if (!consented) {
    return <WelcomeScreen />;
  }

  const hasSessions = sessionIds.length > 0;

  return (
    <>
      <Shell
        onCloseSession={handleCloseSession}
        onNewSession={() => {
          startNewSession();
        }}
      >
        {hasSessions ? (
          <div style={{ height: "100%", position: "relative" }}>
            {sessionIds.map((id) => (
              <SessionPane key={id} sessionId={id} />
            ))}
          </div>
        ) : (
          <div style={emptyStateStyle}>
            No sessions yet — press + to choose a folder and start one.
          </div>
        )}
      </Shell>
      <QuitConfirmHost />
    </>
  );
}

export default App;
