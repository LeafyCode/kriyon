import { SIDEBAR_WIDTH_DEFAULT, useLayout } from "../state/layout.ts";
import { ColumnResizeHandle } from "../ui/ColumnResizeHandle.tsx";

/**
 * Drag to resize the sidebar (persisted via layout state, clamped by the
 * store); double-click resets the default.
 */
function ResizeHandle() {
  const setSidebarWidth = useLayout((state) => state.setSidebarWidth);
  return (
    <ColumnResizeHandle
      onReset={() => setSidebarWidth(SIDEBAR_WIDTH_DEFAULT)}
      onResize={setSidebarWidth}
      testId="sidebar-resize"
      width={() => useLayout.getState().layout.sidebarWidth}
    />
  );
}

export { ResizeHandle };
