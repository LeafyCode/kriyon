import type { CSSProperties } from "react";
import type { HighlightedLine } from "./highlighter.ts";

/**
 * One highlighted line's spans, or the plain text it degrades to.
 *
 * Exists so the two surfaces that render tokenized code — the [Diff hunk] and
 * the read-only [File viewer] — share one renderer. They previously carried
 * near-identical copies of this JSX, which is how `fontStyle` came to be
 * dropped in both: there was no single place that owned "what a token looks
 * like", so the answer was written twice and neither copy grew.
 *
 * `spans` being `undefined` is the normal pre-highlight state (tokenization is
 * async), not an error — the caller's plain `text` renders until it resolves.
 */
export function HighlightedText({
  spans,
  text,
}: {
  spans: HighlightedLine | undefined;
  text: string;
}) {
  if (!spans) {
    return text;
  }
  return spans.map((span, index) => (
    <span
      // Highlighted tokens are positional spans with no stable id, re-derived
      // whole on every highlight resolution.
      // biome-ignore lint/suspicious/noArrayIndexKey: positional, re-derived on every highlight resolution.
      key={index}
      style={spanStyle(span)}
    >
      {span.text}
    </span>
  ));
}

/** `undefined` for an unstyled token, so the common case adds no style object
 * at all — these are built per token, per line, for every visible hunk. */
function spanStyle(span: HighlightedLine[number]): CSSProperties | undefined {
  if (!(span.color || span.bold || span.italic)) {
    return;
  }
  return {
    color: span.color,
    fontStyle: span.italic ? "italic" : undefined,
    // 700, not 600: the self-hosted JetBrains Mono ships Regular and Bold
    // only, so a 600 is synthesized — and a faked bold in a diff is the
    // difference between a highlighted token and a smudged one.
    fontWeight: span.bold ? 700 : undefined,
  };
}
