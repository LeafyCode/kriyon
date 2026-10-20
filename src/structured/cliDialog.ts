import { useEffect, useState } from "react";
import { create } from "zustand";
import { useSessions } from "../state/sessions.ts";
import { screenText } from "../terminal/screenText.ts";
import type { PendingAsk } from "../types.ts";

/**
 * A [CLI dialog]: Claude Code asking for keys in its own terminal — a
 * question, a permission, a plan to approve, or the menu a slash command
 * opens (`/mcp`, `/model`, `/config`, `/resume`, …). The [Structured view]
 * can't draw these, so while one is open the session's own terminal shows
 * over it. Two sources, either one enough: the screen, where every one of
 * Claude Code's dialogs ends in a key hint ("↑/↓ to navigate · Enter to
 * confirm · Esc to cancel") or, for a slash command's pane (`/usage`,
 * `/stats`, `/skills`), starts with a rule of `▔` across the terminal, its
 * hint scrolled out of sight or drawn at the top; and the [Pending ask] the
 * hooks report for a question or a plan to approve (a plan's screen has no
 * hint). A permission's ask isn't used: it stays open while the approved tool
 * runs, long after the prompt is gone, so only its screen says whether it is
 * still up.
 *
 * The screen is read once per beat per session, however many watch it.
 */

/** How often the screen is read for a dialog. */
const DIALOG_POLL_MS = 400;

/** The hint's Esc, at its start or after a `·`. The working line's own
 *  "esc to interrupt" is lower case. */
const ESC_HINT = /(?:^|·\s*)Esc to [a-z]/;

/** How many of the last non-blank rows the hint may be in (it wraps). */
const HINT_ROWS = 2;

/** A slash command's pane opens with a rule of `▔` drawn from the terminal's
 *  first column; the input box's rules are `─`, and Claude's replies and tool
 *  output are indented under `⏺` and `⎿`, so a rule quoted there never starts
 *  the row. Most of the row is the rule: the CLI may draw a short label over
 *  its right end ("◐ medium · /effort"). */
const PANE_RULE_START = /^▔{8}/;
const RULE_GLYPH = /▔/g;

function isPaneRule(row: string): boolean {
  if (!PANE_RULE_START.test(row)) {
    return false;
  }
  const glyphs = row.match(RULE_GLYPH)?.length ?? 0;
  return glyphs * 2 >= row.trimEnd().length;
}

/** Whether `rows` (a screen, top to bottom) show a dialog: they end in its
 *  key hint, or hold a pane's top rule. */
export function dialogOnScreen(rows: readonly string[]): boolean {
  const filled = rows.map((row) => row.trim()).filter((row) => row !== "");
  return (
    filled.slice(-HINT_ROWS).some((row) => ESC_HINT.test(row)) ||
    rows.some(isPaneRule)
  );
}

/** Whether a session's screen ends in a dialog's key hint, per session
 *  watched; a session nobody watches has no entry. */
const useOnScreen = create<Record<string, boolean>>(() => ({}));

/** Per session watched: how many watch it, and its read's timer. */
const watches = new Map<string, { count: number; timer: number }>();

function setOnScreen(sessionId: string, open: boolean | undefined): void {
  if (useOnScreen.getState()[sessionId] === open) {
    return;
  }
  useOnScreen.setState((state) => {
    const { [sessionId]: _was, ...rest } = state;
    return open === undefined ? rest : { ...rest, [sessionId]: open };
  }, true);
}

/** Whether `ask` is one only an open dialog can be (see the module doc). */
function asksInDialog(ask: PendingAsk | null | undefined): boolean {
  return ask !== null && ask !== undefined && ask.kind !== "permission";
}

/**
 * Read `sessionId`'s screen for a dialog until the returned stop is called.
 * Watches share one read; the last stop ends it and forgets what it saw, so
 * nothing stale shows when watching starts again.
 */
export function watchCliDialog(sessionId: string): () => void {
  let watch = watches.get(sessionId);
  if (watch === undefined) {
    const read = () =>
      setOnScreen(sessionId, dialogOnScreen(screenText(sessionId)));
    read();
    watch = { count: 0, timer: window.setInterval(read, DIALOG_POLL_MS) };
    watches.set(sessionId, watch);
  }
  const mine = watch;
  mine.count += 1;
  let stopped = false;
  return () => {
    if (stopped) {
      return;
    }
    stopped = true;
    mine.count -= 1;
    if (mine.count === 0) {
      window.clearInterval(mine.timer);
      watches.delete(sessionId);
      setOnScreen(sessionId, undefined);
    }
  };
}

/** Whether `sessionId` shows a [CLI dialog] now. The screen counts only
 *  while the session is watched ({@link watchCliDialog}). */
export function cliDialogOpen(sessionId: string): boolean {
  return (
    asksInDialog(useSessions.getState().activity[sessionId]?.pendingAsk) ||
    useOnScreen.getState()[sessionId] === true
  );
}

/** Watch `sessionId` and call `listener` each time a dialog opens or closes
 *  there, until the returned stop is called. */
export function followCliDialog(
  sessionId: string,
  listener: (open: boolean) => void
): () => void {
  const stopWatch = watchCliDialog(sessionId);
  let open = cliDialogOpen(sessionId);
  const check = () => {
    const now = cliDialogOpen(sessionId);
    if (now !== open) {
      open = now;
      listener(now);
    }
  };
  const stopAsks = useSessions.subscribe(check);
  const stopScreen = useOnScreen.subscribe(check);
  return () => {
    stopAsks();
    stopScreen();
    stopWatch();
  };
}

/** Whether `sessionId` shows a [CLI dialog] now; never for `null`. */
export function useCliDialog(sessionId: string | null): boolean {
  useEffect(
    () => (sessionId === null ? undefined : watchCliDialog(sessionId)),
    [sessionId]
  );
  const asked = useSessions(
    (state) =>
      sessionId !== null && asksInDialog(state.activity[sessionId]?.pendingAsk)
  );
  const onScreen = useOnScreen(
    (state) => sessionId !== null && state[sessionId] === true
  );
  return asked || onScreen;
}

/** A [CLI dialog]'s detour from the Structured view: `answering` while its
 *  terminal shows over the view, `waiting` once the user put it aside. */
export interface DialogDetour {
  answer: () => void;
  answering: boolean;
  putAside: () => void;
  waiting: boolean;
}

/**
 * The detour for `sessionId` while the Structured view shows it (`on`). The
 * terminal comes up with each new dialog; put aside, it stays down until
 * that dialog closes.
 */
export function useDialogDetour(sessionId: string, on: boolean): DialogDetour {
  const open = useCliDialog(on ? sessionId : null);
  const [aside, setAside] = useState(false);
  useEffect(() => {
    if (!open && aside) {
      setAside(false);
    }
  }, [open, aside]);
  return {
    answer: () => setAside(false),
    answering: open && !aside,
    putAside: () => setAside(true),
    waiting: open && aside,
  };
}
