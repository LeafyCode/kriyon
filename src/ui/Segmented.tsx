import type { CSSProperties } from "react";
import { tokens } from "../theme/tokens.ts";

export interface SegmentedOption<T extends string> {
  /** A mono count rendered after the label — the Changes tab's file count. */
  count?: number;
  /** A segment that can't be chosen right now; `title` should say why. */
  disabled?: boolean;
  label: string;
  /**
   * A `data-testid` on this segment's button.
   *
   * Without it a caller whose tabs are queried by id had to redraw this
   * control rather than use it — which the [File tree pane] did, in forty
   * lines copied from the styles below. One optional field is a smaller
   * change than a second implementation of the same tab strip.
   */
  testId?: string;
  /** A tooltip — for a disabled segment, the reason. */
  title?: string;
  value: T;
}

/**
 * `inset` — a groove with one lit segment: the Changes view's `Changed | All
 * files`, the dock's tab strip, Settings' choice rows.
 *
 * `underline` — the canvas's primary tabs: no track at all, just an accent
 * rule under the active label. Reserved for a control that switches what the
 * whole column shows; anything smaller stays inset, or the screen fills up
 * with things claiming to be the main navigation.
 */
export type SegmentedVariant = "inset" | "underline";

// An *inset* track, not a raised one: the well sits below the plane and the
// selected item is the only thing on it, so the control reads as a groove with
// one lit segment rather than a row of buttons.
const insetTrackStyle: CSSProperties = {
  alignItems: "center",
  background: tokens.color.blockWell,
  border: `1px solid ${tokens.color.line.base}`,
  borderRadius: tokens.radius.md,
  display: "inline-flex",
  gap: "2px",
  padding: "2px",
};

const underlineTrackStyle: CSSProperties = {
  alignItems: "stretch",
  alignSelf: "stretch",
  display: "inline-flex",
  gap: "4px",
};

function insetSegStyle(active: boolean): CSSProperties {
  return {
    alignItems: "center",
    background: active ? tokens.color.surface.active : "transparent",
    border: "none",
    borderRadius: tokens.radius.sm,
    color: active ? tokens.color.ink.primary : tokens.color.ink.muted,
    cursor: "pointer",
    display: "inline-flex",
    fontFamily: tokens.font.sans,
    fontSize: "12px",
    fontWeight: active ? 500 : 400,
    height: "22px",
    padding: "0 10px",
    transition: `color ${tokens.motion.hover}, background ${tokens.motion.hover}`,
  };
}

function underlineSegStyle(active: boolean): CSSProperties {
  return {
    alignItems: "center",
    background: "transparent",
    border: "none",
    // The rule is drawn by a bottom border on a full-height button, so the
    // tab's hit area is the whole 46px row rather than the text's line box.
    borderBottom: `2px solid ${active ? tokens.color.accentBright : "transparent"}`,
    boxSizing: "border-box",
    color: active ? tokens.color.ink.primary : tokens.color.ink.muted,
    cursor: "pointer",
    display: "inline-flex",
    fontFamily: tokens.font.sans,
    fontSize: "13px",
    fontWeight: active ? 500 : 400,
    gap: "7px",
    height: "100%",
    padding: "0 8px",
    transition: `color ${tokens.motion.hover}, border-color ${tokens.motion.hover}`,
  };
}

const countStyle: CSSProperties = {
  color: tokens.color.ink.muted,
  fontFamily: tokens.font.mono,
  fontSize: "11px",
};

/**
 * A two-or-more-way toggle (Changes/Session, Changed/All files).
 *
 * This emits the ARIA tabs pattern, so it owes that pattern's keyboard
 * contract and not just its roles: **roving tabindex** — one tab stop for the
 * whole control, not one per segment — plus ←/→ to move between tabs and
 * Home/End to reach the ends. Activation is automatic (moving selects), which
 * is the pattern's default for a small tablist whose panels are already
 * mounted; here that is literally true, since the views this switches are
 * display-toggled rather than unmounted.
 *
 * ↑/↓ are deliberately NOT bound: this is a horizontal tablist, and the keys
 * belong to whatever list sits below it.
 */
export function Segmented<T extends string>({
  ariaLabel,
  onChange,
  options,
  value,
  variant = "inset",
}: {
  ariaLabel: string;
  onChange: (value: T) => void;
  options: readonly SegmentedOption<T>[];
  value: T;
  variant?: SegmentedVariant;
}) {
  const underline = variant === "underline";
  const current = options.findIndex((option) => option.value === value);

  /** The index an arrow/Home/End lands on, or none for a key we don't own. */
  function nextIndex(key: string): number | null {
    const last = options.length - 1;
    // `current` is -1 when `value` matches no option (a stale persisted
    // value); treat that as "before the first" so an arrow still gets in.
    const from = current === -1 ? 0 : current;
    if (key === "ArrowRight") {
      return from === last ? 0 : from + 1;
    }
    if (key === "ArrowLeft") {
      return from === 0 ? last : from - 1;
    }
    if (key === "Home") {
      return 0;
    }
    if (key === "End") {
      return last;
    }
    return null;
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLDivElement>): void {
    const index = nextIndex(event.key);
    if (index === null) {
      return;
    }
    const option = options[index];
    if (!option || option.disabled) {
      return;
    }
    // Claim the key only once we know it moves the selection, so nothing
    // above this control loses a shortcut it was listening for.
    event.preventDefault();
    onChange(option.value);
  }

  return (
    <div
      aria-label={ariaLabel}
      onKeyDown={onKeyDown}
      role="tablist"
      style={underline ? underlineTrackStyle : insetTrackStyle}
    >
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            aria-selected={active}
            data-testid={option.testId}
            disabled={option.disabled}
            key={option.value}
            onClick={() => onChange(option.value)}
            role="tab"
            style={
              underline ? underlineSegStyle(active) : insetSegStyle(active)
            }
            // Roving tabindex: Tab reaches this control once and the arrows
            // move within it, rather than every segment being its own stop.
            tabIndex={active ? 0 : -1}
            title={option.title}
            type="button"
          >
            {option.label}
            {option.count === undefined || option.count === 0 ? null : (
              <span style={countStyle}>{option.count}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}
