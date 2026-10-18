/** The kind of a highlight segment produced by {@link tokenizeComposer}. */
export type TokenKind = "plain" | "command" | "mention" | "agent";

/** A slice of the composer value plus the pill (or lack of one) it renders as. */
export interface HighlightSegment {
  kind: TokenKind;
  text: string;
}

/** Matches a leading "/command" token: a slash followed by a run of non-space
 * characters, anchored at the start of the string — mirrors the slash trigger
 * in {@link import("./detect.ts").detectTrigger}. */
const LEADING_COMMAND_RE = /^\/\S+/;

/** Matches an "@mention" run: an '@' followed by a run of non-space
 * characters. Matched globally against the whole value; whether a given match
 * counts as a mention (vs. plain text, e.g. mid-word "me@x") is decided by
 * checking the preceding character below. */
const MENTION_RE = /@\S+/g;

const AGENT_PREFIX = "@agent-";

/** A single whitespace character — used to check the char preceding a `@` run. */
const WHITESPACE_RE = /\s/;

/**
 * Split the composer `value` into ordered segments for pill highlighting.
 * Concatenating every segment's `text` reproduces `value` exactly.
 *
 * - A leading `/<non-space-run>` (only at index 0) is one "command" segment.
 * - Any `@<non-space-run>` elsewhere is a "mention" segment (or "agent" if the
 *   run starts with `agent-`), but only when the `@` sits at the very start of
 *   `value` or immediately after whitespace — so `me@x` stays plain.
 * - Everything else is "plain".
 */
export function tokenizeComposer(value: string): HighlightSegment[] {
  const segments: HighlightSegment[] = [];
  let cursor = 0;

  const commandMatch = LEADING_COMMAND_RE.exec(value);
  if (commandMatch) {
    segments.push({ kind: "command", text: commandMatch[0] });
    cursor = commandMatch[0].length;
  }

  MENTION_RE.lastIndex = cursor;
  let match: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: standard regex-exec loop
  while ((match = MENTION_RE.exec(value)) !== null) {
    const start = match.index;
    const precedingChar = value[start - 1];
    const atStart = start === 0;
    const atWordBoundary =
      precedingChar !== undefined && WHITESPACE_RE.test(precedingChar);
    if (!(atStart || atWordBoundary)) {
      continue;
    }
    if (start > cursor) {
      segments.push({ kind: "plain", text: value.slice(cursor, start) });
    }
    const [text] = match;
    const kind: TokenKind = text.startsWith(AGENT_PREFIX) ? "agent" : "mention";
    segments.push({ kind, text });
    cursor = start + text.length;
  }

  if (cursor < value.length) {
    segments.push({ kind: "plain", text: value.slice(cursor) });
  }

  return segments;
}
