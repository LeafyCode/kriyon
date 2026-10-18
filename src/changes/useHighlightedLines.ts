import { useEffect, useState } from "react";
import {
  type HighlightedLine,
  highlightLines,
  peekHighlight,
} from "./highlighter.ts";

/** What this hook is currently showing, and for which input — one state object
 * so the "content changed" adjustment below swaps all three atomically. */
interface HighlightState {
  code: string;
  lang: string;
  spans: HighlightedLine[] | null;
}

function initial(code: string, lang: string, skip: boolean): HighlightState {
  return {
    code,
    lang,
    spans: skip ? null : (peekHighlight(code, lang) ?? null),
  };
}

/** Whether `code` is past `maxLines` and should not be highlighted at all. */
function tooManyLines(code: string, maxLines: number | undefined): boolean {
  return maxLines !== undefined && code.split("\n").length > maxLines;
}

/**
 * Tokenize `code` (in `lang`) into per-line highlighted spans, the one place
 * the "highlight asynchronously, show plain text until it resolves, cancel on
 * change/unmount" effect lives — previously copy-pasted into both `DiffHunk`
 * and the read-only file view, each re-implementing the `cancelled` guard.
 *
 * Returns `null` until the async highlight resolves (the caller renders plain
 * text meanwhile), then the spans. Never throws: `highlightLines` degrades to
 * plain lines internally, and a rejected promise is swallowed rather than
 * breaking the view — the same "never break the view" contract every
 * highlighted surface holds.
 *
 * **Content already tokenized skips `null` entirely.** `DiffFeed` virtualizes,
 * so scrolling unmounts and remounts hunk cards continuously; starting every
 * one of those remounts at `null` meant content whose colours were already
 * known flashed back to plain text for a frame each time it scrolled into
 * view. {@link peekHighlight} answers synchronously for anything still in the
 * cache, so only genuinely new content ever shows a plain frame.
 *
 * `maxLines`, when given, skips highlighting entirely for input past that many
 * lines (a second bound beyond `read_file`'s 1 MB cap, for a pathological
 * mostly-short-lines file) — the caller just renders plain text.
 */
export function useHighlightedLines(
  code: string,
  lang: string,
  maxLines?: number
): HighlightedLine[] | null {
  const skip = tooManyLines(code, maxLines);
  const [state, setState] = useState<HighlightState>(() =>
    initial(code, lang, skip)
  );
  // React's supported "adjust state while rendering" pattern: re-peek the
  // moment the input changes, rather than in an effect, so a card scrolled
  // back into view never commits a plain frame before the effect can run.
  // `setState` with an unchanged value is a no-op, so this only re-renders on
  // an actual input change.
  if (state.code !== code || state.lang !== lang) {
    setState(initial(code, lang, skip));
  }

  const hasSpans = state.spans !== null;
  useEffect(() => {
    if (skip || hasSpans) {
      return;
    }
    let cancelled = false;
    highlightLines(code, lang)
      .then((result) => {
        if (!cancelled) {
          setState({ code, lang, spans: result });
        }
      })
      .catch(() => {
        // highlightLines never throws by contract, but a view must never break
        // even if that contract is somehow violated: keep the plain text.
      });
    return () => {
      cancelled = true;
    };
  }, [code, lang, skip, hasSpans]);

  return state.spans;
}
