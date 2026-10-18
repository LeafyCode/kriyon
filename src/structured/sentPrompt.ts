import type { StructuredTurn } from "../ipc/bridge.ts";

/**
 * How a [Sent prompt] is matched to the turn it became, and whether Esc took
 * it back ([Taken-back prompt], ADR-0037). Pure, so the rules are tested on
 * their own.
 */

const IMAGE_PLACEHOLDER = /\[Image #\d+\]/g;
const TRAILING_SPACE = /\s+$/;

/** How far before a send its turn's first row may be stamped (clocks, and
 *  the row the CLI writes as it takes the prompt). */
const SENT_SLACK_MS = 5000;

/** How long a turn must have been recorded as ended before a status still
 *  saying Running counts as having missed its `Stop`. A new prompt's row
 *  lands well inside this, so a fresh turn is never mistaken for over. */
const ENDED_GRACE_MS = 4000;

/** The newest turn whose prompt is `text` (the CLI may have added `@`
 *  mentions and `[Image #N]` after it); failing that, when `sentAt` is
 *  given, the newest turn begun since then (the CLI rewrote the text — a
 *  pasted file, an expanded command). `null` when none is. */
export function matchingTurn(
  turns: StructuredTurn[],
  text: string,
  sentAt?: number
): StructuredTurn | null {
  const byText = matchingByText(turns, text);
  if (byText !== null || sentAt === undefined) {
    return byText;
  }
  for (let at = turns.length - 1; at >= 0; at -= 1) {
    const turn = turns[at];
    if (
      turn !== undefined &&
      turn.prompt !== null &&
      turn.startedMs !== null &&
      turn.startedMs >= sentAt - SENT_SLACK_MS
    ) {
      return turn;
    }
  }
  return null;
}

/** How the newest turn was recorded as over: when, and whether an Esc
 *  stopped it. */
export interface RecordedEnd {
  endedMs: number;
  interrupted: boolean;
}

/** When the newest turn was recorded as over — ended, or stopped by an
 *  interrupt row, which gets no `turn_duration` — if it was a while ago: the
 *  evidence a Running status may have missed its `Stop` or its Esc. Only
 *  evidence: the newest turn read may be the one *before* a prompt just
 *  sent, so the backend, which knows when that prompt went in, decides. */
export function recordedEnd(
  turns: readonly StructuredTurn[],
  now: number
): RecordedEnd | null {
  // biome-ignore lint/style/useAtIndex: project lib is ES2020; Array.prototype.at is unavailable.
  const last = turns[turns.length - 1];
  const over = last !== undefined && (last.ended || last.interrupted);
  const endedMs = over ? last.endedMs : null;
  if (endedMs === null || now - endedMs <= ENDED_GRACE_MS) {
    return null;
  }
  return { endedMs, interrupted: last?.interrupted ?? false };
}

function matchingByText(
  turns: StructuredTurn[],
  text: string
): StructuredTurn | null {
  const want = text.trim();
  for (let at = turns.length - 1; at >= 0; at -= 1) {
    const turn = turns[at];
    const prompt = turn?.prompt?.trim();
    if (prompt === undefined || turn === undefined) {
      continue;
    }
    const matches =
      want === ""
        ? prompt.replace(IMAGE_PLACEHOLDER, "").trim() === ""
        : prompt === want || prompt.startsWith(`${want} `);
    if (matches) {
      return turn;
    }
  }
  return null;
}

/** Whether Claude has started on a turn: it did something, replied, the
 *  user stopped it, or it is over (a slash command the CLI ran itself may
 *  print nothing). */
export function isProcessed(turn: StructuredTurn): boolean {
  return (
    turn.did.length > 0 || turn.reply !== null || turn.interrupted || turn.ended
  );
}

/** How long a [Sent prompt] is waited for before it is let go (its row never
 *  matched — Claude was given something else, or it never ran). */
export const SENT_PROMPT_TTL_MS = 2 * 60 * 1000;

/** Whether a [Sent prompt] is done with, by what the transcript shows: Claude
 *  started on its turn, or it is too old to wait for. Until then Esc may
 *  still take it back. (A [CLI dialog] it opened closing settles it too; that
 *  shows on the screen, not in `turns`.) */
export function sentSettled(
  sent: { at: number; text: string },
  turns: StructuredTurn[] | null,
  now: number
): boolean {
  if (now - sent.at >= SENT_PROMPT_TTL_MS) {
    return true;
  }
  const turn = turns === null ? null : matchingTurn(turns, sent.text, sent.at);
  return turn !== null && isProcessed(turn);
}

/** Whether Esc took `text`, sent at `sentAt`, back: the CLI does so only
 *  when Claude never started on it, and then writes no interrupt row. A
 *  prompt not read yet counts as taken back — the Esc came before anything
 *  was kept. */
export function wasTakenBack(
  turns: StructuredTurn[],
  text: string,
  sentAt: number
): boolean {
  const turn = matchingTurn(turns, text, sentAt);
  return turn === null || !isProcessed(turn);
}

/** Ctrl+U clears one line of the CLI's input; one more than the message's
 *  lines clears all of it, and a spare press on an empty input is harmless. */
export function clearCliInputKeys(text: string): string {
  return "\u0015".repeat(text.split("\n").length + 1);
}

/** A prompt as the view shows it: without the `[Image #N]` placeholders when
 *  `images` thumbnails stand in for them. */
export function shownPrompt(prompt: string, images: number): string {
  if (images === 0) {
    return prompt;
  }
  return prompt.replace(IMAGE_PLACEHOLDER, "").replace(TRAILING_SPACE, "");
}
