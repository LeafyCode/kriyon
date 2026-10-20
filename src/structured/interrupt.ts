import {
  noteInterrupted,
  type StructuredTurn,
  structuredTurns,
  writeStdin,
} from "../ipc/bridge.ts";
import { useSentPrompts } from "../state/sentPrompts.ts";
import { handBack, untilSent } from "./send.ts";
import { clearCliInputKeys, isProcessed, wasTakenBack } from "./sentPrompt.ts";

/**
 * Esc from the composer, the [Structured view] or the terminal: stop Claude
 * the way the CLI's own Esc does, then look at what the CLI wrote to learn
 * what happened. A prompt Claude never started on goes back in the composer
 * ([Taken-back prompt], ADR-0037); either way the session stops reading as
 * working — Claude Code fires no hook for an interrupt.
 */

const ESC = "\u001b";

/** A second Esc this soon after the first is the same press. Two Escs in a
 *  row mean something else to the CLI (clear the input, or rewind). */
const GATE_MS = 1000;

/** When the turns are read again after an Esc: soon, then once more for a
 *  row that was slow to be kept. */
const SETTLE_MS = [700, 2000];

/** A [Sent prompt] older than this isn't a candidate to take back. */
const RESTORE_WINDOW_MS = 2 * 60 * 1000;

const lastEsc = new Map<string, number>();

/** For tests: forget the last Esc of every session. */
export function resetInterruptGate(): void {
  lastEsc.clear();
}

const encoder = new TextEncoder();

function send(sessionId: string, keys: string): Promise<void> {
  return writeStdin(sessionId, encoder.encode(keys)).catch(() => {
    // Fire-and-forget: the terminal stays the source of truth.
  });
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The CLI put the composer's prompt back in its own input: clear that copy
 *  so the composer is the one place it is, and hand it back. */
async function restore(sessionId: string): Promise<void> {
  const sent = useSentPrompts.getState().sent[sessionId];
  if (sent === undefined) {
    return;
  }
  await send(sessionId, clearCliInputKeys(sent.text));
  handBack(sessionId, sent, "Stopped. Your message is back in the composer.");
}

/** Whether the newest turn shows the Esc landed: an interrupt row, or a
 *  prompt Claude never started on (the CLI took it back). */
function stopped(turns: StructuredTurn[]): boolean {
  // biome-ignore lint/style/useAtIndex: project lib is ES2020; Array.prototype.at is unavailable.
  const last = turns[turns.length - 1];
  return last !== undefined && (last.interrupted || !isProcessed(last));
}

/**
 * What follows an Esc that reached the terminal (Kriyon's, or the user's own
 * in the terminal): read what the CLI kept, take back the composer's prompt
 * if Claude never started on it, and end the working status once the Esc is
 * shown to have stopped the turn.
 */
export async function afterEsc(
  sessionId: string,
  at = Date.now()
): Promise<void> {
  const sent = useSentPrompts.getState().sent[sessionId];
  const restorable = sent !== undefined && at - sent.at <= RESTORE_WINDOW_MS;
  let elapsed = 0;
  for (const settle of SETTLE_MS) {
    // biome-ignore lint/performance/noAwaitInLoops: each check waits for the one before it.
    await wait(settle - elapsed);
    elapsed = settle;
    const turns = await structuredTurns(sessionId).catch(() => null);
    if (turns === null) {
      continue;
    }
    // The prompt may have been answered (and cleared) while we waited.
    const still = useSentPrompts.getState().sent[sessionId];
    if (
      restorable &&
      still === sent &&
      wasTakenBack(turns, sent.text, sent.at)
    ) {
      await restore(sessionId);
      await noteInterrupted(sessionId).catch(() => undefined);
      return;
    }
    if (stopped(turns)) {
      await noteInterrupted(sessionId).catch(() => undefined);
      return;
    }
  }
}

/** Whether an Esc for this session was just handled (see {@link GATE_MS}). */
export function escGated(sessionId: string, now = Date.now()): boolean {
  if (now - (lastEsc.get(sessionId) ?? Number.NEGATIVE_INFINITY) < GATE_MS) {
    return true;
  }
  lastEsc.set(sessionId, now);
  return false;
}

/** Stop the session's turn. Resolves once what followed has been handled. */
export async function interruptSession(sessionId: string): Promise<void> {
  const now = Date.now();
  if (escGated(sessionId, now)) {
    return;
  }
  // A message still being typed would have the Esc land inside it.
  const typing = untilSent(sessionId);
  if (typing !== null) {
    await typing;
  }
  await send(sessionId, ESC);
  await afterEsc(sessionId, now);
}

/**
 * The user pressed Esc in the session's terminal itself. The CLI already has
 * the key; if Claude was working, find out whether it stopped (see
 * {@link afterEsc}).
 */
export function noteTerminalEsc(sessionId: string, running: boolean): void {
  if (!running || escGated(sessionId)) {
    return;
  }
  afterEsc(sessionId).catch(() => undefined);
}
