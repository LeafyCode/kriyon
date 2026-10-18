import type { CSSProperties, ReactNode, TransitionEvent } from "react";
import { useEffect, useState } from "react";
import { tokens } from "../theme/tokens.ts";

/**
 * Settle fallback: transitionend is not guaranteed (a batched double-toggle
 * never starts a transition; an interrupted one fires transitioncancel), so a
 * stuck slide would leave clipped open-content at the closed width forever.
 * Slightly longer than the panel motion duration (see tokens.motion.panel).
 */
const SETTLE_FALLBACK_MS = 400;

export interface CollapsePanelProps {
  /** Content while open — kept mounted through the closing slide. */
  children: ReactNode;
  /** Width in px when closed; 0 hides the panel entirely. */
  closedWidth?: number;
  /** Content once fully closed — e.g. a compact icon rail. */
  collapsedChildren?: ReactNode;
  open: boolean;
  /** Which window edge the panel hugs; content clips at the opposite side. */
  side: "left" | "right";
  testId: string;
  /** Width in px when open. */
  width: number;
}

/**
 * A horizontally collapsing panel host. The wrapper animates its flex basis
 * between the open and closed widths while the inner content keeps its natural
 * width, so panels slide behind the window edge instead of squishing. The
 * transition is armed only by an open/close toggle — a width change alone
 * (drag-resize) applies instantly.
 */
export function CollapsePanel({
  children,
  closedWidth = 0,
  collapsedChildren,
  open,
  side,
  testId,
  width,
}: CollapsePanelProps) {
  const [showOpen, setShowOpen] = useState(open);
  const [prevOpen, setPrevOpen] = useState(open);
  const [sliding, setSliding] = useState(false);

  // Render-phase sync (no effect): an open/close flip arms the transition, and
  // opening restores the open content immediately so it slides back in.
  if (open !== prevOpen) {
    setPrevOpen(open);
    setSliding(true);
    if (open) {
      setShowOpen(true);
    }
  }

  const targetWidth = open ? width : closedWidth;
  const contentWidth = showOpen ? width : closedWidth;

  const wrapperStyle: CSSProperties = {
    display: "flex",
    flex: `0 0 ${targetWidth}px`,
    minWidth: 0,
    overflow: "hidden",
    position: "relative",
    transition: sliding
      ? `flex-basis ${tokens.motion.panel}, width ${tokens.motion.panel}`
      : "none",
    width: `${targetWidth}px`,
  };

  // Pin the content to the window edge so the opposite side gets clipped.
  const contentStyle: CSSProperties = {
    display: "flex",
    flex: `0 0 ${contentWidth}px`,
    marginLeft: side === "right" ? "auto" : undefined,
    marginRight: side === "left" ? "auto" : undefined,
    minWidth: 0,
  };

  // Belt-and-braces settle: if no transitionend/-cancel arrives (double-toggle
  // within one frame, event eaten by an unmount race), settle by timeout so
  // the panel never sticks mid-slide.
  useEffect(() => {
    if (!sliding) {
      return;
    }
    const timer = setTimeout(() => {
      setSliding(false);
      if (!open) {
        setShowOpen(false);
      }
    }, SETTLE_FALLBACK_MS);
    return () => clearTimeout(timer);
  }, [sliding, open]);

  const onTransitionSettled = (event: TransitionEvent<HTMLDivElement>) => {
    // Ignore bubbled transitions from children (hover fades etc.).
    if (event.target !== event.currentTarget) {
      return;
    }
    setSliding(false);
    if (!open) {
      setShowOpen(false);
    }
  };

  const content = showOpen ? children : collapsedChildren;
  return (
    <div
      data-testid={testId}
      // biome-ignore lint/suspicious/noUnknownAttribute: React supports transitioncancel; the rule's attribute list predates it.
      onTransitionCancel={onTransitionSettled}
      onTransitionEnd={onTransitionSettled}
      style={wrapperStyle}
    >
      {content === null || content === undefined ? null : (
        <div style={contentStyle}>{content}</div>
      )}
    </div>
  );
}
