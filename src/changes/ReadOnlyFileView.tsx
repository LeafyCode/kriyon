import { useVirtualizer } from "@tanstack/react-virtual";
import { type CSSProperties, useMemo, useRef } from "react";
import { diffLineColors, tokens } from "../theme/tokens.ts";
import type { FileDiff } from "../types.ts";
import { HighlightedText } from "./HighlightedText.tsx";
import { langForPath } from "./highlighter.ts";
import { useHighlightedLines } from "./useHighlightedLines.ts";

/**
 * Above this many lines, skip syntax highlighting entirely and render plain
 * text. Whole-file tokenization is already bounded by `read_file`'s 1 MB cap,
 * but a pathological file that's mostly short lines (many more lines than a
 * typical 1 MB file) would still make a single-pass tokenization slow — this
 * is a second, independent bound.
 */
export const MAX_HIGHLIGHT_LINES = 10_000;

const OVERSCAN = 8;
/** Rough per-line height (12px mono, 1.6 line-height) before the virtualizer
 * has anything real to measure; only affects the scrollbar's initial size
 * estimate, never what's rendered. */
const ESTIMATED_LINE_HEIGHT = 20;

const HEADER_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/**
 * The new-side line numbers touched by an added diff line, across every hunk
 * of `fileDiff` — the changed-line gutter's source of truth. Walks each hunk
 * from its `@@` header the same way `DiffHunk`'s own line-numbering does: a
 * context or added line advances the new-side counter, a removed line doesn't
 * (and is never itself a "new" line, so it's skipped). The file this view
 * shows is the current (new) version, so these new-side numbers map 1:1 onto
 * its own line numbers.
 */
function addedLineNumbers(fileDiff: FileDiff | undefined): Set<number> {
  const result = new Set<number>();
  if (!fileDiff) {
    return result;
  }
  for (const hunk of fileDiff.hunks) {
    const match = HEADER_RE.exec(hunk.header);
    let newLine = match ? Number(match[2]) : 1;
    for (const line of hunk.lines) {
      if (line.kind === "removed") {
        continue;
      }
      if (line.kind === "added") {
        result.add(newLine);
      }
      newLine += 1;
    }
  }
  return result;
}

const scrollStyle: CSSProperties = {
  flex: 1,
  minHeight: 0,
  overflowY: "auto",
};

function railStyle(totalSize: number): CSSProperties {
  return {
    height: `${totalSize}px`,
    position: "relative",
    width: "100%",
  };
}

// Matches `CodeEditor`'s type scale exactly. The two are alternate renderings
// of the same thing — this one shows up only for a truncated or non-UTF-8
// file — so a reader switching between them should not perceive a change of
// typeface, size or density.
function lineItemStyle(start: number): CSSProperties {
  return {
    display: "flex",
    fontFamily: tokens.font.mono,
    fontSize: "12.5px",
    gap: "6px",
    left: 0,
    lineHeight: 1.55,
    position: "absolute",
    top: 0,
    transform: `translateY(${start}px)`,
    width: "100%",
  };
}

function gutterStyle(changed: boolean): CSSProperties {
  const colors = changed ? diffLineColors("added") : undefined;
  return {
    background: colors?.background,
    // The same `dim` the diff hunk's gutter uses: present when looked for,
    // silent otherwise, so the numbers never compete with the code. It was
    // `ghost`, which on the BisBig plane (ADR-0023) is a step below the
    // faintest readable ink — a line number nobody can read is a column of
    // noise, not restraint.
    color: colors?.color ?? tokens.color.ink.muted,
    display: "inline-block",
    flex: "none",
    fontSize: "11.5px",
    padding: "0 6px 0 12px",
    textAlign: "right",
    userSelect: "none",
    width: "46px",
  };
}

const textStyle: CSSProperties = {
  color: tokens.color.text,
  minWidth: 0,
  whiteSpace: "pre",
};

/**
 * The read-only, syntax-highlighted, virtualized view of a file's whole
 * current content, with a changed-line gutter derived from `fileDiff`. Used
 * for reads that can be shown but never edited — a **truncated** file (past
 * `read_file`'s 1 MB cap, so a save would destroy the untruncated remainder)
 * or a **lossy** one (not valid UTF-8, so a save would rewrite bytes as
 * U+FFFD). It owns its own virtualizer and highlight effect, so none of that
 * machinery runs while an editable file is open — the editor path never
 * mounts this. It never throws: an unknown language or a failed highlight
 * degrades to plain text, same contract `highlightLines` already holds.
 */
export function ReadOnlyFileView({
  content,
  fileDiff,
  path,
}: {
  content: string;
  fileDiff: FileDiff | undefined;
  path: string;
}) {
  const lines = useMemo(() => content.split("\n"), [content]);
  const lang = useMemo(() => langForPath(path), [path]);
  const highlighted = useHighlightedLines(content, lang, MAX_HIGHLIGHT_LINES);

  const changedLines = useMemo(() => addedLineNumbers(fileDiff), [fileDiff]);

  const parentRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: lines.length,
    estimateSize: () => ESTIMATED_LINE_HEIGHT,
    getScrollElement: () => parentRef.current,
    overscan: OVERSCAN,
  });

  return (
    <div data-testid="file-viewer-body" ref={parentRef} style={scrollStyle}>
      <div style={railStyle(virtualizer.getTotalSize())}>
        {virtualizer.getVirtualItems().map((virtualRow) => {
          const { index } = virtualRow;
          const lineNumber = index + 1;
          const changed = changedLines.has(lineNumber);
          const spans = highlighted?.[index];
          return (
            <div
              data-changed={changed ? "true" : undefined}
              data-line-number={lineNumber}
              data-testid="file-viewer-line"
              key={virtualRow.key}
              style={lineItemStyle(virtualRow.start)}
            >
              <span style={gutterStyle(changed)}>{lineNumber}</span>
              <span style={textStyle}>
                <HighlightedText spans={spans} text={lines[index]} />
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
