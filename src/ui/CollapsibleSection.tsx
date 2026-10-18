import { ChevronRight } from "lucide-react";
import type { CSSProperties, ReactNode } from "react";
import { sectionLabel } from "../theme/recipes.ts";
import { tokens } from "../theme/tokens.ts";

export interface CollapsibleSectionProps {
  /** Body content — always mounted, only display-toggled (see module doc). */
  children: ReactNode;
  /** Always-visible slot next to the header, outside the toggle button
   *  (e.g. Task 11's aggregate stats). Rendered regardless of `open`. */
  headerRight?: ReactNode;
  onToggle: (open: boolean) => void;
  open: boolean;
  testId: string;
  title: string;
}

const rootStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
};

const headerRowStyle: CSSProperties = {
  alignItems: "center",
  display: "flex",
  gap: tokens.space.xs,
  justifyContent: "space-between",
  paddingBottom: "6px",
};

const headerButtonStyle: CSSProperties = {
  alignItems: "center",
  background: "transparent",
  border: "none",
  cursor: "pointer",
  display: "flex",
  flex: 1,
  fontFamily: tokens.font.sans,
  gap: tokens.space.xs,
  minWidth: 0,
  padding: 0,
  textAlign: "left",
};

// The section label, not a title: this disclosure's only adapter is the
// Details rail's Changes section, which sits between SESSION and USAGE. In
// title case it read as a different kind of thing than its two neighbours.
const titleStyle: CSSProperties = {
  ...sectionLabel(),
  flex: 1,
  minWidth: 0,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

/** Disclosure chevron — one icon, rotated when open (the standard motion,
 *  matching `ProjectGroup`'s section headers). */
function chevronStyle(expanded: boolean): CSSProperties {
  return {
    alignItems: "center",
    color: tokens.color.ink.faint,
    display: "flex",
    flex: "none",
    transform: expanded ? "rotate(90deg)" : "none",
    transition: `transform ${tokens.motion.disclose}`,
  };
}

/**
 * A vertical titled collapsible: a header `<button>` (chevron + title, plus
 * an optional always-visible `headerRight` slot) that toggles a body.
 *
 * The body is always mounted and only `display`-toggled — never unmounted —
 * so content that owns real state (a live terminal, a virtualized list's
 * scroll position) is never remounted by a collapse/expand.
 */
export function CollapsibleSection({
  children,
  headerRight,
  onToggle,
  open,
  testId,
  title,
}: CollapsibleSectionProps) {
  return (
    <div data-testid={testId} style={rootStyle}>
      <div style={headerRowStyle}>
        <button
          aria-expanded={open}
          onClick={() => onToggle(!open)}
          style={headerButtonStyle}
          type="button"
        >
          <span style={chevronStyle(open)}>
            <ChevronRight size={9} strokeWidth={2} />
          </span>
          <span style={titleStyle}>{title}</span>
        </button>
        {headerRight}
      </div>
      <div style={{ display: open ? "block" : "none" }}>{children}</div>
    </div>
  );
}
