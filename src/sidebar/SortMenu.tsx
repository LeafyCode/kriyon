import type { CSSProperties } from "react";
import type { HideOlderThan, SessionSort } from "../state/layout.ts";
import { row30, sectionLabel } from "../theme/recipes.ts";
import { tokens } from "../theme/tokens.ts";
import { anchoredMenuSurfaceStyle } from "../ui/AnchoredMenu.tsx";

const SORT_LABELS: Record<SessionSort, string> = {
  date: "Date",
  manual: "Manual",
  name: "Name",
};

const HIDE_LABELS: Record<HideOlderThan, string> = {
  "1d": "1 day",
  "1h": "1 hour",
  "1w": "1 week",
  "3d": "3 days",
  "6h": "6 hours",
  off: "Off",
};
const HIDE_ORDER: readonly HideOlderThan[] = [
  "off",
  "1h",
  "6h",
  "1d",
  "3d",
  "1w",
];

const surfaceStyle: CSSProperties = {
  ...anchoredMenuSurfaceStyle,
  minWidth: "150px",
  padding: "4px",
};

const dividerStyle: CSSProperties = {
  borderTop: `1px solid ${tokens.color.line.soft}`,
  margin: "4px 2px",
};

const sectionLabelStyle: CSSProperties = {
  ...sectionLabel(),
  padding: "6px 8px 2px",
};

function itemStyle(selected: boolean): CSSProperties {
  return {
    ...row30({ active: selected }),
    background: "transparent",
    border: "none",
    color: selected ? tokens.color.ink.bright : tokens.color.ink.primary,
    cursor: "pointer",
    gap: "7px",
    textAlign: "left",
    width: "100%",
  };
}

interface SortMenuProps {
  /** The mode currently in effect (for the ✓ mark). */
  current: SessionSort;
  /** Global picker only: renders a "Hide older than" section. Null/omitted on
   *  per-project pickers. */
  hide?: {
    current: HideOlderThan;
    onPick: (value: HideOlderThan) => void;
  };
  /** "Follow global" row — per-project menus only; null hides it. */
  onFollowGlobal: (() => void) | null;
  onPick: (mode: SessionSort) => void;
}

/** The Manual / Date / Name radio popover, shared by the global and
 *  per-project sort pickers. Caller owns open state and the anchor. */
export function SortMenu({
  current,
  hide,
  onFollowGlobal,
  onPick,
}: SortMenuProps) {
  return (
    <div role="menu" style={surfaceStyle}>
      {(Object.keys(SORT_LABELS) as SessionSort[]).map((mode) => (
        <button
          aria-checked={current === mode}
          className="kr-hover-surface"
          key={mode}
          onClick={() => onPick(mode)}
          role="menuitemradio"
          style={itemStyle(current === mode)}
          type="button"
        >
          <span style={{ flex: "none", width: "12px" }}>
            {current === mode ? "✓" : ""}
          </span>
          {SORT_LABELS[mode]}
        </button>
      ))}
      {onFollowGlobal ? (
        <button
          className="kr-hover-surface"
          onClick={onFollowGlobal}
          role="menuitem"
          style={{ ...itemStyle(false), color: tokens.color.ink.muted }}
          type="button"
        >
          <span style={{ flex: "none", width: "12px" }} />
          Follow global
        </button>
      ) : null}
      {hide ? (
        <>
          <div style={dividerStyle} />
          <div style={sectionLabelStyle}>Hide older than</div>
          {HIDE_ORDER.map((value) => (
            <button
              aria-checked={hide.current === value}
              className="kr-hover-surface"
              key={value}
              onClick={() => hide.onPick(value)}
              role="menuitemradio"
              style={itemStyle(hide.current === value)}
              type="button"
            >
              <span style={{ flex: "none", width: "12px" }}>
                {hide.current === value ? "✓" : ""}
              </span>
              {HIDE_LABELS[value]}
            </button>
          ))}
        </>
      ) : null}
    </div>
  );
}
