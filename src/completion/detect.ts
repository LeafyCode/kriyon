/** What the composer's caret position implies about completion, if anything. */
export type Trigger =
  | { kind: "slash"; query: string; start: number; end: number }
  | { kind: "mention"; query: string; start: number; end: number }
  | { kind: "mode"; mode: "bash" | "memory" }
  | null;

const WORD = /\S/;
const WHITESPACE = /\s/;

/**
 * Classify the composer value + caret into a completion trigger. `@` fires at
 * any word boundary; `!`/`#` at input start are bare mode hints. Pure — no
 * React, no IO.
 */
export function detectTrigger(value: string, caret: number): Trigger {
  // Slash: walk back from the caret over non-whitespace to a '/' that is at
  // the start or preceded by whitespace — mirrors the mention backscan below.
  // This lets a SECOND `/command` (typed after an accepted command/mention
  // chip plus a space, or even after ordinary prose) trigger too, not only a
  // command at index 0. False positives are harmless: the popover only opens
  // when commands actually fuzzy-match the query, so a stray '/' in prose
  // (e.g. a file path) matches nothing and never shows a popover.
  let s = caret;
  while (s > 0 && WORD.test(value[s - 1])) {
    s -= 1;
  }
  if (value[s] === "/" && (s === 0 || WHITESPACE.test(value[s - 1]))) {
    return {
      kind: "slash",
      query: value.slice(s + 1, caret),
      start: s,
      end: caret,
    };
  }

  // Mention: walk back from the caret over non-whitespace to an '@' that is at
  // the start or preceded by whitespace.
  let i = caret;
  while (i > 0 && WORD.test(value[i - 1])) {
    i -= 1;
  }
  if (value[i] === "@" && (i === 0 || WHITESPACE.test(value[i - 1]))) {
    return {
      kind: "mention",
      query: value.slice(i + 1, caret),
      start: i,
      end: caret,
    };
  }

  // Mode hints: only when the whole input begins with the prefix.
  if (value.startsWith("!")) {
    return { kind: "mode", mode: "bash" };
  }
  if (value.startsWith("#")) {
    return { kind: "mode", mode: "memory" };
  }

  return null;
}
