import type { StructuredTurn } from "../ipc/bridge.ts";

/**
 * The rules of the [Usage card]: which command opens it, and where it sits
 * among the turns. Pure, so they are tested on their own.
 */

/** `/usage`, and `/cost`, which Claude Code opens on the same pane. */
const USAGE_COMMAND = /^\/(?:usage|cost)$/;

/** Whether `text`, as sent from the composer, asks for the usage card. */
export function isUsageCommand(text: string): boolean {
  return USAGE_COMMAND.test(text.trim());
}

/** How many of `turns` come before `card`: those begun by the time it was
 *  asked for, and any with no time of their own among them. `null` with no
 *  card. */
export function usageCardSlot(
  turns: readonly StructuredTurn[],
  card: { at: number } | undefined
): number | null {
  if (card === undefined) {
    return null;
  }
  const later = turns.findIndex(
    (turn) => turn.startedMs !== null && turn.startedMs > card.at
  );
  return later === -1 ? turns.length : later;
}
