import type { CSSProperties, RefObject } from "react";
import { useLayoutEffect, useState } from "react";
import { createPortal } from "react-dom";
import { sectionLabel } from "../theme/recipes.ts";
import { accentAlpha, tokens } from "../theme/tokens.ts";

/** One rendered line in the popover. */
export interface CompletionRow {
  hint?: string;
  primary: string;
  secondary?: string;
  /** Says where the row's command is answered, when not by Claude. */
  tag?: string;
}

export interface CompletionPopoverProps {
  activeIndex: number;
  /** The composer box the popover should float above. Portaled either way. */
  anchorRef?: RefObject<HTMLElement | null>;
  degraded?: boolean;
  header?: string;
  onPick: (index: number) => void;
  rows: CompletionRow[];
}

const baseListStyle: CSSProperties = {
  background: tokens.color.chrome.overlay,
  border: `1px solid ${tokens.color.border}`,
  borderRadius: tokens.radius.lg,
  boxShadow: tokens.shadow.pop,
  padding: "4px",
  maxHeight: "260px",
  overflowY: "auto",
  position: "fixed",
  zIndex: tokens.z.popover,
};

/** Anchor rect fields the popover needs to place itself above the composer. */
interface AnchorRect {
  left: number;
  top: number;
  width: number;
}

/** Fallback when the anchor hasn't been measured yet (or wasn't provided). */
const FALLBACK_LEFT = 16;
const FALLBACK_WIDTH = 320;

function measure(anchorRef?: RefObject<HTMLElement | null>): AnchorRect | null {
  const el = anchorRef?.current;
  if (!el) {
    return null;
  }
  const rect = el.getBoundingClientRect();
  return { left: rect.left, top: rect.top, width: rect.width };
}

/** Whether two measurements place the popover identically. */
function sameRect(a: AnchorRect | null, b: AnchorRect | null): boolean {
  if (a === null || b === null) {
    return a === b;
  }
  return a.left === b.left && a.top === b.top && a.width === b.width;
}

const rowStyle = (active: boolean): CSSProperties => ({
  alignItems: "baseline",
  background: active ? tokens.color.surface.s3 : "transparent",
  borderRadius: tokens.radius.md,
  cursor: "pointer",
  display: "flex",
  gap: "10px",
  padding: "6px 10px",
});

const primaryStyle: CSSProperties = {
  color: tokens.color.ink.primary,
  fontFamily: tokens.font.mono,
  fontSize: "12px",
};

const secondaryStyle: CSSProperties = {
  color: tokens.color.ink.muted,
  flex: 1,
  fontFamily: tokens.font.sans,
  fontSize: "12px",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const hintStyle: CSSProperties = {
  color: tokens.color.ink.faint,
  fontFamily: tokens.font.mono,
  fontSize: "10.5px",
};

/** "Opens here": a command Kriyon answers itself, in the accent's tint. */
const tagStyle: CSSProperties = {
  background: accentAlpha(0.18),
  borderRadius: tokens.radius.pill,
  color: tokens.color.accentInk,
  flex: "none",
  fontSize: "11px",
  marginLeft: tokens.space.sm,
  padding: "1px 8px",
};

const headerStyle: CSSProperties = {
  ...sectionLabel(),
  padding: "6px 10px 2px",
};

/**
 * The completion list. Purely presentational; the parent owns selection.
 *
 * Portaled to `document.body` and positioned `fixed` from a measured anchor
 * rect so it escapes the composer drawer's `overflow: hidden` ancestor (and
 * the terminal's stacking context) instead of being clipped by it.
 */
export function CompletionPopover({
  rows,
  activeIndex,
  onPick,
  header,
  degraded,
  anchorRef,
}: CompletionPopoverProps) {
  const [rect, setRect] = useState<AnchorRect | null>(() => measure(anchorRef));

  // Re-measure when the list's *size* changes (open/close, grow/shrink) and on
  // viewport resize/scroll, so the popover tracks the composer.
  //
  // Keyed on `rows.length`, not `rows`: the parent rebuilds the array on every
  // keystroke, so depending on its identity re-ran this effect per character —
  // each run calling `getBoundingClientRect` (a forced synchronous layout of
  // the whole list), storing a fresh rect object that re-rendered every row a
  // second time, and tearing down/re-adding both window listeners. The anchor
  // is the composer, whose geometry only moves when the list's height does.
  const rowCount = rows.length;
  // biome-ignore lint/correctness/useExhaustiveDependencies: rowCount triggers a re-measure on open/resize; it isn't read inside the effect body
  useLayoutEffect(() => {
    const onReposition = () =>
      setRect((prev) => {
        const next = measure(anchorRef);
        // Keep the previous object when the geometry hasn't moved, so a scroll
        // or resize that changes nothing doesn't re-render the list.
        return sameRect(prev, next) ? prev : next;
      });
    onReposition();
    window.addEventListener("resize", onReposition);
    window.addEventListener("scroll", onReposition, true);
    return () => {
      window.removeEventListener("resize", onReposition);
      window.removeEventListener("scroll", onReposition, true);
    };
  }, [anchorRef, rowCount]);

  if (rows.length === 0) {
    return null;
  }

  const listStyle: CSSProperties = rect
    ? {
        ...baseListStyle,
        bottom: window.innerHeight - rect.top + 8,
        left: rect.left,
        width: rect.width,
      }
    : {
        ...baseListStyle,
        bottom: 16,
        left: FALLBACK_LEFT,
        width: FALLBACK_WIDTH,
      };

  return createPortal(
    <div role="listbox" style={listStyle}>
      {header ? (
        <div style={headerStyle}>
          {header}
          {degraded ? " · offline" : ""}
        </div>
      ) : null}
      {rows.map((row, index) => (
        <div
          aria-selected={index === activeIndex}
          data-active={index === activeIndex}
          // Keyed by position alone. These rows hold no state — they are a
          // label, a description and a hint — so position is a stable identity
          // and React updates the text in place. Mixing `primary` into the key
          // made the key change whenever ranking reordered the list, which
          // unmounted and remounted every row on each keystroke instead.
          // biome-ignore lint/suspicious/noArrayIndexKey: stateless rows; see comment above
          key={index}
          onMouseDown={(event) => {
            event.preventDefault(); // keep textarea focus
            onPick(index);
          }}
          role="option"
          style={rowStyle(index === activeIndex)}
          tabIndex={-1}
        >
          <span style={primaryStyle}>{row.primary}</span>
          {row.secondary ? (
            <span style={secondaryStyle}>{row.secondary}</span>
          ) : (
            <span style={{ flex: 1 }} />
          )}
          {row.hint ? <span style={hintStyle}>{row.hint}</span> : null}
          {row.tag ? <span style={tagStyle}>{row.tag}</span> : null}
        </div>
      ))}
    </div>,
    document.body
  );
}
