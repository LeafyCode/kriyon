/**
 * The small slice of Markdown Claude's replies use, parsed for the
 * [Structured view]: fenced code, headings, lists and paragraphs, with inline
 * code, bold, italic and links. Text only — the view renders it as React
 * elements, never as HTML, and anything it doesn't know stays as typed.
 */

import { findLinks } from "../terminal/links.ts";

export type Inline =
  | { kind: "text"; text: string }
  | { kind: "code"; text: string }
  // Bold and italic hold pieces of their own: `**`npm i`:**` is bold
  // around a code span, not bold text with backticks in it.
  | { children: Inline[]; kind: "bold" }
  | { children: Inline[]; kind: "italic" }
  // A Markdown `[label](target)`, or a URL, path or path-like code span found
  // in the reply. `target` is as written; the view decides what it opens.
  | { children: Inline[]; kind: "link"; target: string };

export type Block =
  | { kind: "code"; text: string }
  | { kind: "heading"; inline: Inline[] }
  | { kind: "list"; items: Inline[][]; ordered: boolean }
  | { kind: "para"; inline: Inline[] };

const FENCE = /^\s*(```|~~~)/;
const HEADING = /^#{1,6}\s+(.*)$/;
const BULLET = /^\s*[-*+]\s+(.*)$/;
const NUMBERED = /^\s*\d+[.)]\s+(.*)$/;
const CRLF = /\r\n?/g;

// `code`, **bold**, *italic* / _italic_, [label](target) — the earliest
// match wins.
const INLINE =
  /`([^`\n]+)`|\*\*([^*\n]+?)\*\*|\*([^*\s][^*\n]*?)\*|\b_([^_\n]+?)_\b|\[([^\]\n]+)\]\(((?:[^()\s]|\([^()\s]*\))+)\)/;

/** Whether a code span is one URL or path and nothing else. The strict
 *  prose rule, not `looksLikePath`: a bare `console.log` or `Next.js` reads
 *  as a file name, and a click on it would only fail. */
function isWholeLink(code: string): boolean {
  const found = findLinks(code);
  return (
    found.length === 1 && found[0]?.start === 0 && found[0].end === code.length
  );
}

/** Plain text with its URLs and paths as links — for text that is not
 *  Markdown, like a step's input, and for the prose between Markdown marks. */
export function linkText(text: string): Inline[] {
  const out: Inline[] = [];
  let at = 0;
  for (const found of findLinks(text)) {
    if (found.start > at) {
      out.push({ kind: "text", text: text.slice(at, found.start) });
    }
    out.push({
      children: [{ kind: "text", text: found.token }],
      kind: "link",
      target: found.token,
    });
    at = found.end;
  }
  if (at < text.length) {
    out.push({ kind: "text", text: text.slice(at) });
  }
  return out;
}

/**
 * Split one line or paragraph into its inline pieces. URLs and paths become
 * links, except inside a link's own label (`linked`), which is one already.
 */
export function parseInline(text: string, linked = false): Inline[] {
  const out: Inline[] = [];
  let rest = text;
  const push = (piece: Inline) => {
    const [last] = out.slice(-1);
    if ("text" in piece && piece.text === "") {
      return;
    }
    if (piece.kind === "text" && last?.kind === "text") {
      last.text += piece.text;
    } else {
      out.push(piece);
    }
  };
  const pushText = (prose: string) => {
    for (const piece of linked
      ? [{ kind: "text", text: prose } as const]
      : linkText(prose)) {
      push(piece);
    }
  };
  for (let match = INLINE.exec(rest); match; match = INLINE.exec(rest)) {
    pushText(rest.slice(0, match.index));
    const [whole, code, bold, star, under, label, target] = match;
    if (code !== undefined) {
      const piece: Inline = { kind: "code", text: code };
      push(
        !linked && isWholeLink(code)
          ? { children: [piece], kind: "link", target: code }
          : piece
      );
    } else if (label !== undefined && target !== undefined) {
      push({ children: parseInline(label, true), kind: "link", target });
    } else if (bold === undefined) {
      push({
        children: parseInline(star ?? under ?? "", linked),
        kind: "italic",
      });
    } else {
      push({ children: parseInline(bold, linked), kind: "bold" });
    }
    rest = rest.slice(match.index + whole.length);
  }
  pushText(rest);
  return out;
}

function listItem(line: string): { ordered: boolean; text: string } | null {
  const bullet = BULLET.exec(line);
  if (bullet) {
    return { ordered: false, text: bullet[1] ?? "" };
  }
  const numbered = NUMBERED.exec(line);
  return numbered ? { ordered: true, text: numbered[1] ?? "" } : null;
}

/** The code from a fence opened at `lines[open]`, and the line after it. */
function readFence(
  lines: string[],
  open: number,
  marker: string
): { block: Block; next: number } {
  const code: string[] = [];
  let i = open + 1;
  while (i < lines.length && !(lines[i] ?? "").trim().startsWith(marker)) {
    code.push(lines[i] ?? "");
    i += 1;
  }
  return { block: { kind: "code", text: code.join("\n") }, next: i + 1 };
}

/** The list starting at `lines[first]`, and the line after it. */
function readList(
  lines: string[],
  first: number,
  ordered: boolean
): { block: Block; next: number } {
  const items: Inline[][] = [];
  let i = first;
  for (
    let item = listItem(lines[i] ?? "");
    item && item.ordered === ordered;
    item = listItem(lines[i] ?? "")
  ) {
    items.push(parseInline(item.text));
    i += 1;
  }
  return { block: { items, kind: "list", ordered }, next: i };
}

/** A reply's blocks, in order. */
export function parseReply(text: string): Block[] {
  const lines = text.replace(CRLF, "\n").split("\n");
  const blocks: Block[] = [];
  let para: string[] = [];
  const endPara = () => {
    if (para.length > 0) {
      blocks.push({ inline: parseInline(para.join("\n")), kind: "para" });
      para = [];
    }
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    const fence = FENCE.exec(line);
    const item = listItem(line);
    const heading = HEADING.exec(line);
    if (fence || item) {
      endPara();
      const read = fence
        ? readFence(lines, i, fence[1] ?? "```")
        : readList(lines, i, item?.ordered ?? false);
      blocks.push(read.block);
      i = read.next;
      continue;
    }
    if (heading) {
      endPara();
      blocks.push({ inline: parseInline(heading[1] ?? ""), kind: "heading" });
    } else if (line.trim() === "") {
      endPara();
    } else {
      para.push(line);
    }
    i += 1;
  }
  endPara();
  return blocks;
}
