/**
 * Clean terminal copy: rejoin soft-wrapped rows into logical lines so copied
 * text has no mid-line breaks. Operates over a minimal buffer-like interface so
 * the logic is testable without a real xterm instance.
 */

interface BufferLineLike {
  isWrapped: boolean;
  /** `translateToString(true)` — trailing whitespace already trimmed by xterm. */
  text: string;
}

interface BufferActiveLike {
  getLine: (y: number) => BufferLineLike | undefined;
  length: number;
}

const TRAILING_WS = /\s+$/;

export interface TerminalLike {
  buffer: { active: BufferActiveLike };
  getSelectionPosition: () =>
    | { start: { x: number; y: number }; end: { x: number; y: number } }
    | undefined;
  hasSelection: () => boolean;
}

/**
 * Rejoin soft-wrapped rows in `[startY, endY]` into logical lines. A row whose
 * `isWrapped` is true is a CONTINUATION of the previous row, so it is
 * concatenated with no newline; a `"\n"` is inserted only before a row whose
 * `isWrapped` is false (a real new logical line). Trailing whitespace is
 * trimmed per logical line.
 */
export function reflowLines(
  term: TerminalLike,
  startY: number,
  endY: number
): string {
  const { active } = term.buffer;
  const start = Math.max(0, startY);
  const end = Math.min(active.length - 1, endY);

  const logicalLines: string[] = [];
  for (let y = start; y <= end; y += 1) {
    const line = active.getLine(y);
    if (!line) {
      continue;
    }
    if (line.isWrapped && logicalLines.length > 0) {
      logicalLines[logicalLines.length - 1] += line.text;
    } else {
      logicalLines.push(line.text);
    }
  }

  return logicalLines
    .map((logical) => logical.replace(TRAILING_WS, ""))
    .join("\n");
}

/** Clean copy of the current selection (logical-line reflowed). */
export function copySelection(term: TerminalLike): string {
  if (!term.hasSelection()) {
    return "";
  }
  const position = term.getSelectionPosition();
  if (!position) {
    return "";
  }
  return reflowLines(term, position.start.y, position.end.y);
}

/** Clean copy of a block's output rows `[outputStart, outputEnd]`. */
export function copyBlockOutput(
  term: TerminalLike,
  range: { outputStart: number; outputEnd: number }
): string {
  return reflowLines(term, range.outputStart, range.outputEnd);
}
