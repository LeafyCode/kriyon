import type { CSSProperties } from "react";
import { tokens } from "../theme/tokens.ts";

/** The invisible drag strip along a column's right edge. The host column
 * must be `position: relative`. */
const handleStyle: CSSProperties = {
  bottom: 0,
  cursor: "col-resize",
  position: "absolute",
  right: "-3px",
  top: 0,
  width: "6px",
  zIndex: tokens.z.sticky,
};

/**
 * Drag a column's right edge to resize it; double-click resets it. The
 * caller owns the width (persisted, clamped) — this only turns pointer
 * movement into a new width. Listeners attach per drag and always detach on
 * release.
 */
export function ColumnResizeHandle({
  onReset,
  onResize,
  testId,
  width,
}: {
  onReset: () => void;
  onResize: (width: number) => void;
  testId: string;
  /** Read at drag start, so a drag resizes from the width on screen. */
  width: () => number;
}) {
  const startDrag = (event: {
    clientX: number;
    preventDefault: () => void;
  }) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = width();
    const onMove = (move: MouseEvent) => {
      onResize(startWidth + (move.clientX - startX));
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  return (
    <div
      aria-hidden
      data-testid={testId}
      onDoubleClick={onReset}
      onMouseDown={startDrag}
      style={handleStyle}
    />
  );
}
