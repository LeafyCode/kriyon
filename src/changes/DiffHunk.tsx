import { type CSSProperties, memo, useMemo } from "react";
import { diffLineColors, tokens } from "../theme/tokens.ts";
import type { DiffHunk as DiffHunkData, DiffLine } from "../types.ts";
import { HighlightedText } from "./HighlightedText.tsx";
import type { HighlightedLine } from "./highlighter.ts";
import { useHighlightedLines } from "./useHighlightedLines.ts";

/** A line paired with its old/new line numbers, once walked from the
 * hunk's `@@` header start, plus where it sits in the side text it is
 * tokenized as part of (see {@link hunkSides}). */
interface NumberedLine {
  line: DiffLine;
  /** Index of this line within {@link HunkSides.newCode}'s lines, or `null`
   * for a removed line (which exists only on the old side). */
  newIndex: number | null;
  newLineNo: number | null;
  /** Index within {@link HunkSides.oldCode}'s lines, or `null` for an added
   * line. */
  oldIndex: number | null;
  oldLineNo: number | null;
}

/**
 * A hunk's two sides as separately-tokenizable source.
 *
 * The old side is context + removed lines; the new side is context + added
 * lines. Each is (a fragment of) real source in a way the interleaved text
 * never is: concatenating a removed line and the added line replacing it
 * produces code that no grammar can parse correctly, and a TextMate grammar
 * is a state machine — once an unterminated string, block comment, template
 * literal or JSX expression sends it down the wrong branch, every following
 * line in the hunk is mis-coloured too. That was the real reason diff colours
 * never matched an editor's; no theme change could have reached it.
 *
 * Still a *fragment*: both sides start mid-file, so a hunk opening inside a
 * construct that began above it can still start in the wrong state. Fixing
 * that needs whole-file context (shiki's `grammarState`), which costs a file
 * read per changed file — not worth it for the remaining error, which is now
 * rare rather than systematic.
 */
interface HunkSides {
  newCode: string;
  oldCode: string;
}

function hunkSides(hunk: DiffHunkData): HunkSides {
  const oldLines: string[] = [];
  const newLines: string[] = [];
  for (const line of hunk.lines) {
    if (line.kind !== "added") {
      oldLines.push(line.text);
    }
    if (line.kind !== "removed") {
      newLines.push(line.text);
    }
  }
  return { newCode: newLines.join("\n"), oldCode: oldLines.join("\n") };
}

const HEADER_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/**
 * Parses the starting old/new line numbers out of a `@@ -a,b +c,d @@` hunk
 * header. A missing or malformed header numbers from 1 rather than failing
 * to render — a diff must never disappear because a header didn't parse.
 */
function hunkStart(header: string): { newStart: number; oldStart: number } {
  const match = HEADER_RE.exec(header);
  if (!match) {
    return { newStart: 1, oldStart: 1 };
  }
  return { newStart: Number(match[2]), oldStart: Number(match[1]) };
}

/**
 * Walks a hunk's lines from its header start positions: a context line
 * advances both counters, an added line only the new counter, a removed
 * line only the old counter.
 */
function numberLines(hunk: DiffHunkData): NumberedLine[] {
  const start = hunkStart(hunk.header);
  let oldLine = start.oldStart;
  let newLine = start.newStart;
  // Positions within each side's text — the same walk, since a line is
  // appended to a side exactly when that side's counter advances.
  let oldIndex = 0;
  let newIndex = 0;
  return hunk.lines.map((line) => {
    if (line.kind === "removed") {
      const row: NumberedLine = {
        line,
        newIndex: null,
        newLineNo: null,
        oldIndex,
        oldLineNo: oldLine,
      };
      oldLine += 1;
      oldIndex += 1;
      return row;
    }
    if (line.kind === "added") {
      const row: NumberedLine = {
        line,
        newIndex,
        newLineNo: newLine,
        oldIndex: null,
        oldLineNo: null,
      };
      newLine += 1;
      newIndex += 1;
      return row;
    }
    const row: NumberedLine = {
      line,
      newIndex,
      newLineNo: newLine,
      oldIndex,
      oldLineNo: oldLine,
    };
    oldLine += 1;
    newLine += 1;
    oldIndex += 1;
    newIndex += 1;
    return row;
  });
}

/** The hunk's own well, a step darker than the card it sits in — the same
 * relationship the editor's code area has to its frame, so a diff body and an
 * open file read as the same surface. */
const wellStyle: CSSProperties = {
  background: tokens.color.chrome.content,
};

const headerStyle: CSSProperties = {
  color: tokens.color.ink.muted,
  fontFamily: tokens.font.mono,
  fontSize: "11px",
  padding: "3px 12px",
};

/** Line numbers: quiet enough to disappear while reading code, legible the
 * moment they're looked for. `dim`, not `ghost` — a number nobody can read is
 * a column of noise. */
const gutterStyle: CSSProperties = {
  color: tokens.color.ink.muted,
  display: "inline-block",
  flex: "none",
  fontFamily: tokens.font.mono,
  fontSize: "11px",
  textAlign: "right",
  userSelect: "none",
  width: "34px",
};

const signStyle: CSSProperties = {
  display: "inline-block",
  flex: "none",
  fontFamily: tokens.font.mono,
  fontSize: "12px",
  opacity: 0.6,
  textAlign: "center",
  width: "16px",
};

const textStyle: CSSProperties = { whiteSpace: "pre" };

function rowStyle(kind: DiffLine["kind"]): CSSProperties {
  const base: CSSProperties = {
    background: "transparent",
    display: "flex",
    fontFamily: tokens.font.mono,
    fontSize: "11.5px",
    gap: "6px",
    lineHeight: 1.7,
    padding: "1px 12px",
  };
  return { ...base, ...diffLineColors(kind) };
}

/**
 * The spans for one row, taken from the side that row actually belongs to: a
 * removed line only exists on the old side, an added line only on the new
 * one. A context line reads from the new side — it appears on both, and the
 * new side is the file as it stands now.
 */
function rowSpans(
  row: NumberedLine,
  oldSpans: HighlightedLine[] | null,
  newSpans: HighlightedLine[] | null
): HighlightedLine | undefined {
  if (row.line.kind === "removed") {
    return row.oldIndex === null ? undefined : oldSpans?.[row.oldIndex];
  }
  return row.newIndex === null ? undefined : newSpans?.[row.newIndex];
}

function sign(kind: DiffLine["kind"]): string {
  if (kind === "added") {
    return "+";
  }
  if (kind === "removed") {
    return "-";
  }
  return " ";
}

/**
 * One `@@ … @@` region of a file diff: old/new line-number gutters, a sign
 * column, and the line content. Content renders as plain text immediately
 * and upgrades in place to syntax-highlighted spans once the async
 * `highlightLines` call resolves — a failed or unsupported-language
 * highlight (or a rejected promise) leaves the plain text in place rather
 * than breaking the card.
 */
function DiffHunkImpl({ hunk, lang }: { hunk: DiffHunkData; lang: string }) {
  // Memoized on `hunk` identity: with the component memoized below, these
  // O(lines) walks run once per hunk, not once per parent scroll frame.
  const rows = useMemo(() => numberLines(hunk), [hunk]);
  const sides = useMemo(() => hunkSides(hunk), [hunk]);
  // Two calls, but not two tokenizations for the common case: `highlightLines`
  // is keyed on content, so a hunk with no removed lines (or none added) has
  // identical sides and shares one cached result.
  const oldSpans = useHighlightedLines(sides.oldCode, lang);
  const newSpans = useHighlightedLines(sides.newCode, lang);

  return (
    <div data-testid="diff-hunk" style={wellStyle}>
      <div style={headerStyle}>{hunk.header}</div>
      {rows.map((row, index) => (
        <div
          data-testid="diff-hunk-row"
          // Diff lines are positional and have no stable id; index is the
          // append-only position within this hunk.
          // biome-ignore lint/suspicious/noArrayIndexKey: positional, append-only list with no unique key.
          key={index}
          style={rowStyle(row.line.kind)}
        >
          <span data-testid="diff-old-lineno" style={gutterStyle}>
            {row.oldLineNo ?? ""}
          </span>
          <span data-testid="diff-new-lineno" style={gutterStyle}>
            {row.newLineNo ?? ""}
          </span>
          <span style={signStyle}>{sign(row.line.kind)}</span>
          <span style={textStyle}>
            <HighlightedText
              spans={rowSpans(row, oldSpans, newSpans)}
              text={row.line.text}
            />
          </span>
        </div>
      ))}
    </div>
  );
}

/**
 * Memoized: a `DiffFileCard`'s hunks are re-rendered whenever the
 * {@link DiffFeed} virtualizer re-renders (every scroll frame). `hunk` and
 * `lang` keep their identity across a scroll, so memo skips the re-render
 * (and the `numberLines` walk / highlight effect) entirely for an unchanged
 * hunk.
 */
export const DiffHunk = memo(DiffHunkImpl);
