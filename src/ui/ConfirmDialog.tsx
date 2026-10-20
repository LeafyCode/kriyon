/**
 * The app's one "are you sure?" modal: a centered {@link Overlay} panel with a
 * title, a line of body copy, and a Cancel / destructive-confirm pair. Each
 * adapter (the terminal's close-over-live-work warning, the sidebar's
 * clear-a-project and close-one-session confirms) supplies only its own
 * wording, so a destructive decision looks and behaves the same wherever it
 * is asked.
 *
 * Deliberately modal rather than an anchored popover: a confirm that hangs off
 * its trigger lands as a block of text over whatever was beneath it (in a
 * 278px sidebar rail, over the other projects), and a decision that ends live
 * work deserves the scrim's full stop.
 */
import { type CSSProperties, type ReactNode, useId } from "react";
import { button } from "../theme/recipes.ts";
import { tokens } from "../theme/tokens.ts";
import { Overlay } from "./Overlay.tsx";

const panelStyle: CSSProperties = {
  background: tokens.color.chrome.overlay,
  border: `1px solid ${tokens.color.border}`,
  borderRadius: tokens.radius.xl,
  boxShadow: tokens.shadow.pop,
  maxWidth: "360px",
  padding: "18px 18px 14px",
};

const widePanelStyle: CSSProperties = {
  ...panelStyle,
  maxWidth: "460px",
  width: "100%",
};

const titleStyle: CSSProperties = {
  color: tokens.color.ink.bright,
  fontFamily: tokens.font.sans,
  fontSize: "14px",
  fontWeight: 700,
  margin: "0 0 6px",
};

/** The panel's line of body copy. Exported for other {@link DialogPanel}s. */
export const dialogBodyStyle: CSSProperties = {
  color: tokens.color.ink.muted,
  fontFamily: tokens.font.sans,
  fontSize: "13px",
  lineHeight: 1.45,
  margin: "0 0 16px",
};

/** The command lines a stop would end: monospace, one per row, never wrapped
 * into the prose. A shell one-liner is long and punctuation-heavy, so reading
 * it as part of a sentence is what made the old warning unreadable. */
const detailsStyle: CSSProperties = {
  background: tokens.color.blockWell,
  border: `1px solid ${tokens.color.line.base}`,
  borderRadius: tokens.radius.md,
  listStyle: "none",
  margin: "-8px 0 16px",
  maxHeight: "132px",
  overflowY: "auto",
  padding: "6px 8px",
};

const detailItemStyle: CSSProperties = {
  color: tokens.color.ink.muted,
  display: "flex",
  fontFamily: tokens.font.mono,
  fontSize: "11px",
  gap: tokens.space.xs,
  lineHeight: 1.6,
};

/** Fixed, so a long command truncates without taking its bullet with it. */
const bulletStyle: CSSProperties = {
  flex: "none",
  opacity: 0.6,
};

const detailTextStyle: CSSProperties = {
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const actionsStyle: CSSProperties = {
  display: "flex",
  gap: tokens.space.sm,
  justifyContent: "flex-end",
};

const cancelStyle: CSSProperties = button("secondary");

const confirmStyle: CSSProperties = button("danger");

export interface ConfirmDialogProps {
  /** Optional test id on the scrim, for tests that assert the modal is up. */
  backdropTestId?: string;
  body: string;
  /** The destructive button's label ("Quit & stop", "Close 2 sessions"). */
  confirmLabel: string;
  /** Test id on the destructive button. */
  confirmTestId?: string;
  /** Command lines (or similar) listed under the body, one per row. */
  details?: string[];
  /** Accessible name for the scrim's close button, e.g. "Cancel closing". */
  label: string;
  onCancel: () => void;
  onConfirm: () => void;
  title: string;
}

/**
 * The modal panel every app dialog sits in: the scrim, the panel, the title
 * and the dialog semantics, with the buttons in a row at the bottom.
 * {@link ConfirmDialog} is the common case; a dialog with more to show (the
 * update dialog) passes its own body.
 */
export function DialogPanel({
  actions,
  backdropTestId,
  children,
  label,
  onClose,
  testId,
  title,
  wide = false,
}: {
  actions: ReactNode;
  backdropTestId?: string;
  children: ReactNode;
  /** Accessible name for the scrim's close button. */
  label: string;
  onClose: () => void;
  testId?: string;
  title: string;
  /** Room for release notes or a list, not just a line of copy. */
  wide?: boolean;
}) {
  // Names the panel for assistive tech. Without `role="dialog"` + a label, a
  // screen reader announces the scrim's close button and nothing about what
  // is being asked — so the semantics live here, once, for every dialog.
  const titleId = useId();
  return (
    <Overlay
      align="center"
      backdropTestId={backdropTestId}
      label={label}
      onClose={onClose}
    >
      <div
        aria-labelledby={titleId}
        aria-modal="true"
        data-testid={testId}
        role="dialog"
        style={wide ? widePanelStyle : panelStyle}
      >
        <p id={titleId} style={titleStyle}>
          {title}
        </p>
        {children}
        <div style={actionsStyle}>{actions}</div>
      </div>
    </Overlay>
  );
}

export function ConfirmDialog({
  backdropTestId,
  body,
  details,
  confirmLabel,
  confirmTestId,
  label,
  onCancel,
  onConfirm,
  title,
}: ConfirmDialogProps) {
  return (
    <DialogPanel
      actions={
        <>
          <button
            className="kr-hover-surface"
            onClick={onCancel}
            style={cancelStyle}
            type="button"
          >
            Cancel
          </button>
          <button
            data-testid={confirmTestId}
            onClick={onConfirm}
            style={confirmStyle}
            type="button"
          >
            {confirmLabel}
          </button>
        </>
      }
      backdropTestId={backdropTestId}
      label={label}
      onClose={onCancel}
      title={title}
    >
      <p style={dialogBodyStyle}>{body}</p>
      {details && details.length > 0 ? (
        <ul data-testid="confirm-details" style={detailsStyle}>
          {details.map((line, index) => (
            // Keyed by position: two background shells running the identical
            // command is ordinary (the same `pnpm dev` started twice), and
            // the text would then be a duplicate key. The list is static for
            // the life of the dialog, so position is stable.
            // biome-ignore lint/suspicious/noArrayIndexKey: the list never reorders
            <li key={index} style={detailItemStyle} title={line}>
              <span aria-hidden="true" style={bulletStyle}>
                •
              </span>
              <span style={detailTextStyle}>{line}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </DialogPanel>
  );
}
