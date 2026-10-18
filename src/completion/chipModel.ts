import type { TokenKind } from "./highlightTokens.ts";
import { tokenizeComposer } from "./highlightTokens.ts";

/** The token kinds that render as an atomic chip (everything but "plain"),
 * plus the two single-char mode chips (`bash`/`memory`) that {@link
 * buildFragment} synthesizes for a leading `!`/`#` — those never come out of
 * {@link tokenizeComposer} itself, so they live outside `TokenKind`. */
export type ChipKind = Exclude<TokenKind, "plain"> | "bash" | "memory";

/** The single leading character that puts the composer into bash or memory
 * mode — mirrors the `startsWith` checks in {@link
 * import("./detect.ts").detectTrigger}. */
const MODE_CHARS: Record<string, ChipKind> = { "!": "bash", "#": "memory" };

const CHIP_ATTR = "data-chip";
const KIND_ATTR = "data-kind";

/** True for an element built by {@link makeChip}. */
function isChip(node: Node): node is HTMLElement {
  return (
    node.nodeType === Node.ELEMENT_NODE &&
    (node as Element).hasAttribute(CHIP_ATTR)
  );
}

/** The plain-string contribution of a single child of the editable: a chip's
 * full token text, a text node's data, a `<br>` as a newline, or (defensively,
 * for any other stray element) its own serialization. */
function serializeNode(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) {
    return (node as Text).data;
  }
  if (isChip(node)) {
    return node.textContent ?? "";
  }
  if (node.nodeType === Node.ELEMENT_NODE) {
    const el = node as Element;
    if (el.tagName === "BR") {
      return "\n";
    }
    let inner = "";
    for (const child of Array.from(el.childNodes)) {
      inner += serializeNode(child);
    }
    return inner;
  }
  return "";
}

/**
 * The plain-string draft value: the editable's childNodes walked in document
 * order, concatenating each chip's token text and each text node's data. This
 * is what gets stored via `useDrafts.setDraft` and written to the PTY.
 */
export function serializeEditable(root: HTMLElement): string {
  let out = "";
  for (const child of Array.from(root.childNodes)) {
    out += serializeNode(child);
  }
  return out;
}

/** Build a chip span: `contenteditable=false` makes the caret step over it as
 * one atomic unit (and Backspace delete it whole). Styling is applied by the
 * caller (inline style / class) — this only sets the structural attributes. */
export function makeChip(
  doc: Document,
  kind: ChipKind,
  token: string
): HTMLSpanElement {
  const span = doc.createElement("span");
  span.setAttribute("contenteditable", "false");
  span.setAttribute(CHIP_ATTR, "");
  span.setAttribute(KIND_ATTR, kind);
  span.textContent = token;
  return span;
}

/**
 * Build the editable's content from a plain draft string: a leading `!`/`#`
 * (only at index 0 — Claude-parity bash/memory mode) becomes its own
 * single-char mode chip first, then the remainder is tokenized as usual
 * (`tokenizeComposer`) into command/mention/agent chips and plain text.
 * `serializeEditable` of the result (appended under any element) round-trips
 * back to `value`.
 */
export function buildFragment(doc: Document, value: string): DocumentFragment {
  const fragment = doc.createDocumentFragment();
  const modeKind = MODE_CHARS[value[0]];
  const rest = modeKind ? value.slice(1) : value;
  if (modeKind) {
    fragment.appendChild(makeChip(doc, modeKind, value[0]));
  }
  for (const segment of tokenizeComposer(rest)) {
    if (segment.kind === "plain") {
      fragment.appendChild(doc.createTextNode(segment.text));
    } else {
      fragment.appendChild(makeChip(doc, segment.kind, segment.text));
    }
  }
  return fragment;
}

/**
 * The linear offset within `serializeEditable(root)` that a DOM caret
 * position (`node`, `offset`) corresponds to. Handles the two shapes a
 * collapsed selection takes here: a character offset inside a text-node
 * child of `root`, or a child-index offset directly on `root` itself (how a
 * caret sitting right after an atomic chip is often reported).
 */
export function caretOffsetInValue(
  root: HTMLElement,
  node: Node,
  offset: number
): number {
  const children = Array.from(root.childNodes);

  if (node === root) {
    let total = 0;
    for (let i = 0; i < offset && i < children.length; i += 1) {
      total += serializeNode(children[i]).length;
    }
    return total;
  }

  let total = 0;
  for (const child of children) {
    if (child === node) {
      // A character offset inside this text-node child.
      return total + offset;
    }
    if (child.contains(node)) {
      // The caret landed inside a nested node (e.g. a chip's own text node,
      // which shouldn't normally happen since chips are contenteditable=false)
      // — treat it as sitting right after this whole child.
      return total + serializeNode(child).length;
    }
    total += serializeNode(child).length;
  }
  return total;
}

/** A DOM position: a node plus a character/child offset into it. */
export interface DomPosition {
  endNode: Node;
  endOffset: number;
  startNode: Node;
  startOffset: number;
}

/**
 * The inverse of {@link caretOffsetInValue}: map a linear `[start, end)` span
 * of `value` back to a DOM range. Only handles spans that fall entirely
 * within a single text-node child of `root` — true for every in-progress
 * completion token, which is always plain typed text. Returns `null` when no
 * single text node covers the whole span (including when `end` runs past
 * `value.length`).
 */
export function locateRange(
  root: HTMLElement,
  value: string,
  start: number,
  end: number
): DomPosition | null {
  if (start < 0 || end > value.length || start > end) {
    return null;
  }
  let cursor = 0;
  for (const child of Array.from(root.childNodes)) {
    const len = serializeNode(child).length;
    if (
      child.nodeType === Node.TEXT_NODE &&
      start >= cursor &&
      end <= cursor + len
    ) {
      return {
        startNode: child,
        startOffset: start - cursor,
        endNode: child,
        endOffset: end - cursor,
      };
    }
    cursor += len;
  }
  return null;
}
