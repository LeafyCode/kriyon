import type { PartialReply, StructuredTurn } from "../ipc/bridge.ts";

/** The most characters of a block the companion streams; longer ones arrive
 *  cut there, with "…" after (companion.js `cap`). */
const STREAM_CAP = 20_000;
const CUT_MARK = "…";

/**
 * Whether a [Partial reply] is still worth drawing under the newest turn: it
 * belongs to that turn (arrived after its prompt) and its text isn't already
 * one the turn kept (the block's row has landed, so the turn shows it).
 */
export function liveText(
  partial: PartialReply | null,
  turns: readonly StructuredTurn[]
): string | null {
  if (partial === null || partial.text.trim() === "") {
    return null;
  }
  // biome-ignore lint/style/useAtIndex: project lib is ES2020; Array.prototype.at is unavailable.
  const last = turns[turns.length - 1];
  if (last === undefined) {
    return partial.text;
  }
  if (last.startedMs !== null && partial.receivedMs < last.startedMs) {
    return null;
  }
  const kept = [
    last.reply,
    ...last.did.map((item) => (item.kind === "text" ? item.text : null)),
  ];
  return kept.some((text) => text !== null && isKept(partial.text, text))
    ? null
    : partial.text;
}

/** Whether `streamed` is the text the turn kept as `text`. A streamed block
 *  that was cut short is matched by the part that was sent. */
function isKept(streamed: string, text: string): boolean {
  const cut =
    streamed.length === STREAM_CAP + CUT_MARK.length &&
    streamed.endsWith(CUT_MARK);
  return cut
    ? text.startsWith(streamed.slice(0, STREAM_CAP))
    : text.trim() === streamed.trim();
}
