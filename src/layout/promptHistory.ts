/**
 * The composer's Up/Down walk through [Prompt history], the CLI's way: Up on
 * the first line goes back one prompt, Down on the last line comes forward,
 * and coming forward past the newest gives back the draft the walk began on.
 */

export interface HistoryCursor {
  /** The entry shown: -1 is the user's own draft. */
  index: number;
  /** The draft as it was when the walk began. */
  stash: string;
}

export const START: HistoryCursor = { index: -1, stash: "" };

/** One step: `dir` 1 is Up (older), -1 is Down (newer). `null` when there
 *  is nowhere to go, so the arrow just moves the caret. */
export function stepHistory(
  cursor: HistoryCursor,
  entries: readonly string[],
  dir: 1 | -1,
  draft: string
): { cursor: HistoryCursor; text: string } | null {
  const index = cursor.index + dir;
  if (index < -1 || index >= entries.length) {
    return null;
  }
  const stash = cursor.index === -1 ? draft : cursor.stash;
  return {
    cursor: { index, stash },
    text: index === -1 ? stash : (entries[index] ?? ""),
  };
}

/** Whether the caret at `offset` is on the draft's first line. */
export function onFirstLine(value: string, offset: number): boolean {
  return !value.slice(0, offset).includes("\n");
}

/** Whether the caret at `offset` is on the draft's last line. */
export function onLastLine(value: string, offset: number): boolean {
  return !value.slice(offset).includes("\n");
}
