import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import type { TerminalTab } from "../state/terminals.ts";

type LayoutChanged = (
  layout: Record<string, number>,
  meta: { isUserInteraction: boolean }
) => void;

// The last Group's onLayoutChanged, so a test can play a finished drag.
let lastOnLayoutChanged: LayoutChanged | undefined;

vi.mock("react-resizable-panels", () => ({
  Group: ({
    children,
    onLayoutChanged,
    orientation,
  }: {
    children: ReactNode;
    onLayoutChanged: LayoutChanged;
    orientation: string;
  }) => {
    lastOnLayoutChanged = onLayoutChanged;
    return <div data-orientation={orientation}>{children}</div>;
  },
  Panel: ({
    children,
    defaultSize,
    id,
  }: {
    children: ReactNode;
    defaultSize: string;
    id: string;
  }) => (
    <div data-default-size={defaultSize} data-testid={`panel-${id}`}>
      {children}
    </div>
  ),
  Separator: () => <div data-testid="resize-handle" />,
}));

vi.mock("./TerminalPaneView.tsx", () => ({
  TerminalPaneView: ({
    paneId,
    active,
  }: {
    active: boolean;
    paneId: string;
  }) => <div data-active={active} data-testid={`pane-${paneId}`} />,
}));

import { TabPaneGrid } from "./TabPaneGrid.tsx";

function tab(overrides: Partial<TerminalTab> = {}): TerminalTab {
  return {
    activePaneId: "p1",
    direction: "row",
    id: "t1",
    layout: [],
    panes: [{ cwd: "/r", id: "p1" }],
    title: "Terminal 1",
    ...overrides,
  };
}

const noop = () => {
  /* no-op */
};

describe("TabPaneGrid", () => {
  it("renders a single pane without resize handles", () => {
    render(
      <TabPaneGrid
        isPaneDead={() => false}
        onClosePane={noop}
        onFocusPane={noop}
        onLayout={noop}
        onRestartPane={noop}
        onSplitPane={noop}
        tab={tab()}
        visible
      />
    );
    expect(screen.getByTestId("pane-p1")).toBeTruthy();
    expect(screen.queryByTestId("resize-handle")).toBeNull();
  });

  it("renders a Group with a handle between two panes and maps direction", () => {
    const { container } = render(
      <TabPaneGrid
        isPaneDead={() => false}
        onClosePane={noop}
        onFocusPane={noop}
        onLayout={noop}
        onRestartPane={noop}
        onSplitPane={noop}
        tab={tab({
          direction: "column",
          panes: [
            { cwd: "/r", id: "p1" },
            { cwd: "/r", id: "p2" },
          ],
        })}
        visible
      />
    );
    expect(screen.getByTestId("pane-p1")).toBeTruthy();
    expect(screen.getByTestId("pane-p2")).toBeTruthy();
    expect(screen.getAllByTestId("resize-handle")).toHaveLength(1);
    expect(
      container.querySelector("[data-orientation='vertical']")
    ).toBeTruthy();
  });

  it("marks only the active pane active when visible", () => {
    render(
      <TabPaneGrid
        isPaneDead={() => false}
        onClosePane={noop}
        onFocusPane={noop}
        onLayout={noop}
        onRestartPane={noop}
        onSplitPane={noop}
        tab={tab({
          activePaneId: "p2",
          panes: [
            { cwd: "/r", id: "p1" },
            { cwd: "/r", id: "p2" },
          ],
        })}
        visible
      />
    );
    expect(screen.getByTestId("pane-p1").getAttribute("data-active")).toBe(
      "false"
    );
    expect(screen.getByTestId("pane-p2").getAttribute("data-active")).toBe(
      "true"
    );
  });

  it("marks no pane active when not visible", () => {
    render(
      <TabPaneGrid
        isPaneDead={() => false}
        onClosePane={noop}
        onFocusPane={noop}
        onLayout={noop}
        onRestartPane={noop}
        onSplitPane={noop}
        tab={tab()}
        visible={false}
      />
    );
    expect(screen.getByTestId("pane-p1").getAttribute("data-active")).toBe(
      "false"
    );
  });

  it("sizes panels from the saved layout, as percentages", () => {
    render(
      <TabPaneGrid
        isPaneDead={() => false}
        onClosePane={noop}
        onFocusPane={noop}
        onLayout={noop}
        onRestartPane={noop}
        onSplitPane={noop}
        tab={tab({
          layout: [30, 70],
          panes: [
            { cwd: "/r", id: "p1" },
            { cwd: "/r", id: "p2" },
          ],
        })}
        visible
      />
    );
    // A bare number would mean pixels in react-resizable-panels v4.
    expect(screen.getByTestId("panel-p1").dataset.defaultSize).toBe("30%");
    expect(screen.getByTestId("panel-p2").dataset.defaultSize).toBe("70%");
  });

  it("reports sizes in pane order after a drag, and ignores layout changes nobody made", () => {
    const onLayout = vi.fn();
    render(
      <TabPaneGrid
        isPaneDead={() => false}
        onClosePane={noop}
        onFocusPane={noop}
        onLayout={onLayout}
        onRestartPane={noop}
        onSplitPane={noop}
        tab={tab({
          panes: [
            { cwd: "/r", id: "p1" },
            { cwd: "/r", id: "p2" },
          ],
        })}
        visible
      />
    );
    lastOnLayoutChanged?.({ p1: 50, p2: 50 }, { isUserInteraction: false });
    expect(onLayout).not.toHaveBeenCalled();
    lastOnLayoutChanged?.({ p2: 75, p1: 25 }, { isUserInteraction: true });
    expect(onLayout).toHaveBeenCalledWith([25, 75]);
  });
});
