import type { CSSProperties } from "react";
import { SIDEBAR_WIDTH_DEFAULT, useLayout } from "../state/layout.ts";
import { tokens } from "../theme/tokens.ts";

/** The invisible drag strip along the sidebar's right edge. */
const resizeHandleStyle: CSSProperties = {
  bottom: 0,
  cursor: "col-resize",
  position: "absolute",
  right: "-3px",
  top: 0,
  width: "6px",
  zIndex: tokens.z.sticky,
};

/**
 * Drag to resize the sidebar (persisted via layout state, clamped by the
 * store); double-click resets the default. Listeners attach per-drag and
 * always detach on release.
 */
function ResizeHandle() {
  const setSidebarWidth = useLayout((state) => state.setSidebarWidth);

  const startDrag = (event: {
    clientX: number;
    preventDefault: () => void;
  }) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = useLayout.getState().layout.sidebarWidth;
    const onMove = (move: MouseEvent) => {
      setSidebarWidth(startWidth + (move.clientX - startX));
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
      data-testid="sidebar-resize"
      onDoubleClick={() => setSidebarWidth(SIDEBAR_WIDTH_DEFAULT)}
      onMouseDown={startDrag}
      style={resizeHandleStyle}
    />
  );
}

export { ResizeHandle };
