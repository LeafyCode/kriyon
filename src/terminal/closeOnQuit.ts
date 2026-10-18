import { isTauriRuntime, type QuitIntent, quitApp } from "../ipc/bridge.ts";
import { useSessions } from "../state/sessions.ts";
import {
  describeCommands,
  hasTotalStopCost,
  listedCommands,
  plural,
  stopCostOfAll,
  type TotalStopCost,
} from "../state/stopCost.ts";
import { type QuitStakes, useTerminals } from "../state/terminals.ts";

/**
 * The window close-requested gate — every gated quit gesture arrives here, not
 * just the close button: the app menu's ⌘Q and the tray's "Quit Kriyon" both
 * route through the main window's close (see `quit::request_quit`), so one gate
 * answers them all.
 *
 * Quitting stops everything Kriyon hosts — every [Session]'s whole process tree
 * and every Project terminal — and the next launch resumes each conversation
 * the first time it is opened. So the gate asks exactly when a quit would
 * destroy something resume cannot bring back (see {@link quitStakes}); a quit
 * with nothing at stake just quits.
 *
 * Either way this `preventDefault`s (synchronously — the event API
 * demands it) and owns the outcome, because Tauri's own fallback for an
 * un-prevented close is `window.destroy()`, which this app must not use: it
 * would leave the app running behind the tray with the main window gone for
 * good, and the capability ACL does not grant it, so the click did nothing at
 * all. Exported for tests; wired by {@link installCloseOnQuit}.
 */
export function handleCloseRequested(event: {
  preventDefault: () => void;
}): Promise<void> {
  event.preventDefault();
  const terminals = useTerminals.getState();
  const stakes = quitStakes(
    terminals.hasBusyPanes(),
    stopCostOfAll(useSessions.getState())
  );
  if (stakes) {
    terminals.setQuitConfirm(stakes);
    return Promise.resolve();
  }
  return quitApp("stopAll");
}

/**
 * What a quit would destroy right now, or `null` when the answer is nothing and
 * the quit may proceed unasked. Pure so the rule is testable without a window.
 */
export function quitStakes(
  busyTerminals: boolean,
  sessions: TotalStopCost
): QuitStakes | null {
  if (!(busyTerminals || hasTotalStopCost(sessions))) {
    return null;
  }
  return {
    busyTerminals,
    commands: sessions.commands,
    starting: sessions.starting,
    working: sessions.working,
  };
}

/**
 * The quit confirmation's wording for these {@link QuitStakes}. It says what
 * will be stopped and names the commands, so nothing dies as a surprise.
 *
 * The dialog's only choice is whether to quit at all. There is no "quit but
 * keep that turn going": a session with no window anywhere is how a half-a-
 * gigabyte `claude` tree is left behind, and every conversation is saved by
 * `claude --resume` either way.
 */
export function quitCopy(stakes: QuitStakes): {
  body: string;
  details: string[];
  title: string;
} {
  const lines: string[] = [];
  if (stakes.working > 0) {
    lines.push(
      `Claude is still working in ${plural(stakes.working, "session")}.`
    );
  }
  if (stakes.starting > 0) {
    lines.push(
      `${plural(stakes.starting, "session")} still starting up, and quitting stops that.`
    );
  }
  if (stakes.busyTerminals) {
    lines.push(
      "A project terminal still has a process running, and quitting stops it."
    );
  }
  if (stakes.working > 0) {
    lines.push("Every conversation is saved and resumes where it left off.");
  }
  // Last, so the list it introduces sits directly beneath it.
  if (stakes.commands.length > 0) {
    lines.push(`Quitting stops ${describeCommands(stakes.commands)}:`);
  }
  return {
    body: lines.join(" "),
    details: listedCommands(stakes.commands),
    title: "Quit and stop these?",
  };
}

/**
 * The user answered the quit confirmation. Quits through the app (not the
 * window), so it cannot re-prompt, and hands Rust the choice: it does the
 * stopping on its way out, for every session — including ones this window never
 * mounted, which the frontend could not reach.
 */
export function confirmQuit(intent: QuitIntent): Promise<void> {
  return quitApp(intent);
}

/**
 * Gate real app quits (window close, ⌘Q, or the tray's Quit — the last two
 * arrive as a window close too), NOT a webview reload: Tauri's
 * `onCloseRequested` fires only on the former, which is exactly the
 * reload-survives / quit-stops distinction sessions and Project terminals want.
 *
 * Returns an unlisten function. A no-op outside the Tauri runtime (browser QA).
 */
export function installCloseOnQuit(): () => void {
  if (!isTauriRuntime()) {
    return () => {
      // No Tauri runtime (browser QA): nothing to unlisten.
    };
  }
  let unlisten: (() => void) | undefined;
  let cancelled = false;
  import("@tauri-apps/api/window")
    .then(({ getCurrentWindow }) =>
      getCurrentWindow().onCloseRequested((event) =>
        handleCloseRequested(event)
      )
    )
    .then((fn) => {
      if (cancelled) {
        fn();
      } else {
        unlisten = fn;
      }
    })
    .catch(() => {
      // Non-fatal: an ungated quit still stops every session on its way out.
    });
  return () => {
    cancelled = true;
    unlisten?.();
  };
}
