/**
 * The pieces every Settings page is built from: the page with its title and
 * lead, a group of rows on one card, and a labelled row with its control.
 * Shared by the pages in `SettingsView.tsx` and those in their own files.
 */
import { Children, type CSSProperties, type ReactNode } from "react";
import { card, sectionLabel } from "../theme/recipes.ts";
import { tokens } from "../theme/tokens.ts";
import { type SettingsSectionId, sectionTitle } from "./settingsSections.ts";

export const pageStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "28px",
  maxWidth: "1120px",
};

export const pageTitleStyle: CSSProperties = {
  color: tokens.color.ink.bright,
  fontSize: "20px",
  fontWeight: 500,
  margin: 0,
};

export const pageLeadStyle: CSSProperties = {
  color: tokens.color.ink.secondary,
  fontSize: "13px",
  lineHeight: 1.5,
  margin: "6px 0 0",
};

export const groupStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: tokens.space.sm,
};

export const groupLabelStyle: CSSProperties = {
  ...sectionLabel(),
  paddingLeft: "2px",
};

/** The group's card; its rows are hairline-separated, not boxed one by one. */
export const groupCardStyle: CSSProperties = {
  ...card(),
  display: "flex",
  flexDirection: "column",
  overflow: "hidden",
};

export const dividerStyle: CSSProperties = {
  borderTop: `1px solid ${tokens.color.line.soft}`,
};

/**
 * A preference row: the name and hint on the left, the control on the right.
 * `minHeight`, not `height`: a couple of the hints run to a sentence or two,
 * and clipping the explanation to hold the rhythm costs more than it's worth.
 */
export const rowStyle: CSSProperties = {
  alignItems: "center",
  display: "flex",
  gap: tokens.space.xl,
  justifyContent: "space-between",
  minHeight: "56px",
  padding: "14px 18px",
};

export const stackedRowStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: tokens.space.md,
  padding: "14px 18px",
};

export const rowTextStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "4px",
  maxWidth: "62ch",
  minWidth: 0,
};

export const rowLabelStyle: CSSProperties = {
  color: tokens.color.ink.primary,
  fontSize: "13px",
  fontWeight: 500,
};

export const rowHintStyle: CSSProperties = {
  color: tokens.color.ink.muted,
  fontSize: "12px",
  lineHeight: 1.5,
};

export const errorTextStyle: CSSProperties = {
  ...rowHintStyle,
  color: tokens.color.status.error,
  padding: `${tokens.space.sm} 14px`,
};

/** One labelled preference row: a name (with optional hint) and its control. */
export function SettingRow({
  label,
  hint,
  control,
  stacked = false,
}: {
  control: ReactNode;
  hint?: ReactNode;
  label: string;
  /** Put the control under the label — for one too wide to sit beside it. */
  stacked?: boolean;
}) {
  return (
    <div style={stacked ? stackedRowStyle : rowStyle}>
      <div style={rowTextStyle}>
        <span data-setting-label style={rowLabelStyle}>
          {label}
        </span>
        {hint ? <span style={rowHintStyle}>{hint}</span> : null}
      </div>
      {control}
    </div>
  );
}

/**
 * A group of related preference rows on one card, with a hairline between
 * rows (never after the last — a trailing rule under the card's own border
 * reads as a doubled edge). `label` names the region, and is shown above the
 * card unless `hideLabel` (when the page title already says it).
 */
export function SettingGroup({
  label,
  children,
  hideLabel = false,
}: {
  children: ReactNode;
  hideLabel?: boolean;
  label: string;
}) {
  const rows = Children.toArray(children);
  return (
    <section aria-label={label} style={groupStyle}>
      {hideLabel ? null : <span style={groupLabelStyle}>{label}</span>}
      <div style={groupCardStyle}>
        {rows.map((row, index) => (
          <div
            key={typeof row === "object" && "key" in row ? row.key : label}
            style={index === 0 ? undefined : dividerStyle}
          >
            {row}
          </div>
        ))}
      </div>
    </section>
  );
}

/** One Settings section: its title (its side-menu entry), a line on what it
 *  covers, its groups. */
export function SectionPage({
  children,
  id,
  lead,
}: {
  children: ReactNode;
  id: SettingsSectionId;
  lead: ReactNode;
}) {
  return (
    <div style={pageStyle}>
      <div>
        <h2 style={pageTitleStyle}>{sectionTitle(id)}</h2>
        <p style={pageLeadStyle}>{lead}</p>
      </div>
      {children}
    </div>
  );
}
