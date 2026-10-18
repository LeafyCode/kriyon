import type { CSSProperties } from "react";
import { Fragment } from "react";
import type { Layout, LayoutChangedMeta } from "react-resizable-panels";
import { Group, Panel, Separator } from "react-resizable-panels";
import type { TerminalTab } from "../state/terminals.ts";
import { tokens } from "../theme/tokens.ts";
import { TerminalPaneView } from "./TerminalPaneView.tsx";

// A 1px hairline, not a 3px bar: the split seam is a boundary, not a control,
// and the canvas draws every boundary at one pixel. The handle keeps a wider
// hit area via `border` on either side of the painted line.
const handleStyleRow: CSSProperties = {
  background: tokens.color.line.base,
  backgroundClip: "content-box",
  borderLeft: "1px solid transparent",
  borderRight: "1px solid transparent",
  cursor: "col-resize",
  flex: "0 0 3px",
};

const handleStyleColumn: CSSProperties = {
  background: tokens.color.line.base,
  backgroundClip: "content-box",
  borderBottom: "1px solid transparent",
  borderTop: "1px solid transparent",
  cursor: "row-resize",
  flex: "0 0 3px",
};

/**
 * The split layout of one {@link TerminalTab}'s panes. A single-pane tab renders
 * one pane with no resize handles; a multi-pane tab lays panes out with
 * `react-resizable-panels` in the tab's direction. `visible` gates whether panes
 * may hold a WebGL context (only the active pane of a visible tab is active).
 */
export function TabPaneGrid({
  isPaneDead,
  onClosePane,
  onFocusPane,
  onLayout,
  onRestartPane,
  onSplitPane,
  tab,
  visible,
}: {
  isPaneDead: (paneId: string) => boolean;
  onClosePane: (paneId: string) => void;
  onFocusPane: (paneId: string) => void;
  onLayout: (sizes: number[]) => void;
  onRestartPane: (paneId: string) => void;
  onSplitPane: (paneId: string) => void;
  tab: TerminalTab;
  visible: boolean;
}) {
  if (tab.panes.length === 1) {
    const [pane] = tab.panes;
    return (
      <div style={{ height: "100%" }}>
        <TerminalPaneView
          active={visible}
          cwd={pane.cwd}
          dead={isPaneDead(pane.id)}
          onClose={() => onClosePane(pane.id)}
          onFocus={() => onFocusPane(pane.id)}
          onRestart={() => onRestartPane(pane.id)}
          onSplit={() => onSplitPane(pane.id)}
          paneId={pane.id}
          showControls={false}
        />
      </div>
    );
  }

  const handleStyle =
    tab.direction === "row" ? handleStyleRow : handleStyleColumn;

  // Saved only after a drag, so `layout` stays `[]` until the user moves the
  // splitter (see `layoutWithAddedPane`). The library reports sizes by panel
  // id; the store keeps them in pane order.
  const handleLayoutChanged = (layout: Layout, meta: LayoutChangedMeta) => {
    if (meta.isUserInteraction) {
      onLayout(tab.panes.map((pane) => layout[pane.id] ?? 0));
    }
  };

  return (
    <Group
      onLayoutChanged={handleLayoutChanged}
      orientation={tab.direction === "row" ? "horizontal" : "vertical"}
    >
      {tab.panes.map((pane, i) => (
        <Fragment key={pane.id}>
          {i > 0 ? <Separator style={handleStyle} /> : null}
          {/* Sizes are percentages; a bare number would mean pixels. */}
          <Panel
            defaultSize={`${tab.layout[i] ?? 100 / tab.panes.length}%`}
            id={pane.id}
            minSize="10%"
          >
            <TerminalPaneView
              active={visible && pane.id === tab.activePaneId}
              cwd={pane.cwd}
              dead={isPaneDead(pane.id)}
              onClose={() => onClosePane(pane.id)}
              onFocus={() => onFocusPane(pane.id)}
              onRestart={() => onRestartPane(pane.id)}
              onSplit={() => onSplitPane(pane.id)}
              paneId={pane.id}
              showControls
            />
          </Panel>
        </Fragment>
      ))}
    </Group>
  );
}
