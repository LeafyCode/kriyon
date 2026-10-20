import type { CSSProperties, ReactNode } from "react";
import { sectionLabel } from "../theme/recipes.ts";
import { tokens } from "../theme/tokens.ts";

/**
 * Section divider + padding for the sections that live *below* the Details
 * body's own 22px-gapped column (the activity panels). The first one omits
 * its top border.
 */
export function sectionStyle(first = false): CSSProperties {
  return {
    borderTop: first ? "none" : `1px solid ${tokens.color.line.soft}`,
    padding: "16px 18px",
  };
}

/** The one section label, shared with the sidebar, Settings and the tray. */
export const sectionLabelStyle: CSSProperties = sectionLabel();

export const headingRowStyle: CSSProperties = {
  alignItems: "center",
  display: "flex",
  justifyContent: "space-between",
  paddingBottom: "8px",
};

export const monoMutedStyle: CSSProperties = {
  color: tokens.color.ink.muted,
  fontFamily: tokens.font.mono,
  fontSize: "11px",
};

/**
 * A coarse "just now / Nm ago / Nh ago / Nd ago" label for a past epoch-ms
 * timestamp. Used for relative times throughout the inspector.
 */
export function agoLabel(fromMs: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - fromMs) / 1000));
  if (seconds < 60) {
    return "just now";
  }
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  const hours = Math.round(minutes / 60);
  if (hours < 24) {
    return `${hours}h ago`;
  }
  return `${Math.round(hours / 24)}d ago`;
}

/** {@link agoLabel} from an ISO timestamp; `null`/invalid renders an em dash. */
export function agoFromIso(iso: string | null): string {
  if (!iso) {
    return "—";
  }
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? "—" : agoLabel(ms);
}

/**
 * An inspector section with an uppercase label and an optional right-aligned
 * count/meta, matching the Changes/Usage/Session sections.
 */
export function Section({
  label,
  meta,
  first,
  children,
}: {
  label: string;
  meta?: ReactNode;
  first?: boolean;
  children: ReactNode;
}) {
  return (
    <section style={sectionStyle(first)}>
      <div style={headingRowStyle}>
        <span style={sectionLabelStyle}>{label}</span>
        {meta === null || meta === undefined ? null : (
          <span style={monoMutedStyle}>{meta}</span>
        )}
      </div>
      {children}
    </section>
  );
}
