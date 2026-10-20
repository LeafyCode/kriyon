import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./TabPaneGrid.tsx", () => ({
  TabPaneGrid: ({
    tab,
    visible,
  }: {
    tab: { id: string };
    visible: boolean;
  }) => <div data-testid={`grid-${tab.id}`} data-visible={String(visible)} />,
}));

vi.mock("./sessionHost.ts", () => ({ disposeSession: vi.fn() }));

import { useTerminals } from "../state/terminals.ts";
import { TerminalWorkspace } from "./TerminalWorkspace.tsx";

beforeEach(() => useTerminals.setState({ busyPanes: {}, byProject: {} }));

describe("TerminalWorkspace", () => {
  it("empty state offers a New terminal button that opens a tab", () => {
    render(<TerminalWorkspace cwd="/repo" projectId="proj" visible />);
    fireEvent.click(screen.getByRole("button", { name: "New terminal" }));
    expect(useTerminals.getState().byProject.proj.tabs).toHaveLength(1);
  });

  it("renders a tab per tab and the active grid", () => {
    const id = useTerminals.getState().openTab("proj", "/repo");
    render(<TerminalWorkspace cwd="/repo" projectId="proj" visible />);
    expect(screen.getByTestId(`grid-${id}`)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Terminal 1" })).toBeTruthy();
  });

  it("keeps every tab mounted, toggling visibility (switching never unmounts)", () => {
    const a = useTerminals.getState().openTab("proj", "/repo");
    const b = useTerminals.getState().openTab("proj", "/repo"); // b is active
    render(<TerminalWorkspace cwd="/repo" projectId="proj" visible />);
    // Both grids are in the DOM — the inactive tab is hidden, not destroyed,
    // so its terminal (and scrollback) survives a switch.
    expect(screen.getByTestId(`grid-${a}`)).toBeTruthy();
    expect(screen.getByTestId(`grid-${b}`)).toBeTruthy();
    expect(screen.getByTestId(`tab-pane-${a}`).style.display).toBe("none");
    expect(screen.getByTestId(`tab-pane-${b}`).style.display).not.toBe("none");
  });

  it("switching the active tab flips visibility without remounting grids", () => {
    const a = useTerminals.getState().openTab("proj", "/repo");
    const b = useTerminals.getState().openTab("proj", "/repo"); // b active
    render(<TerminalWorkspace cwd="/repo" projectId="proj" visible />);
    const gridA = screen.getByTestId(`grid-${a}`);
    const gridB = screen.getByTestId(`grid-${b}`);
    fireEvent.click(screen.getByRole("button", { name: "Terminal 1" }));
    // Same DOM nodes — no remount — only the display toggles.
    expect(screen.getByTestId(`grid-${a}`)).toBe(gridA);
    expect(screen.getByTestId(`grid-${b}`)).toBe(gridB);
    expect(screen.getByTestId(`tab-pane-${a}`).style.display).not.toBe("none");
    expect(screen.getByTestId(`tab-pane-${b}`).style.display).toBe("none");
  });

  it("passes visible only to the active tab's grid", () => {
    const a = useTerminals.getState().openTab("proj", "/repo");
    useTerminals.getState().openTab("proj", "/repo"); // second tab is active
    render(<TerminalWorkspace cwd="/repo" projectId="proj" visible />);
    // The hidden tab must not be 'visible' — that gate keeps it off WebGL/focus.
    expect(screen.getByTestId(`grid-${a}`).dataset.visible).toBe("false");
  });

  it("the + button adds a tab", () => {
    useTerminals.getState().openTab("proj", "/repo");
    render(<TerminalWorkspace cwd="/repo" projectId="proj" visible />);
    fireEvent.click(screen.getByRole("button", { name: "New terminal tab" }));
    expect(useTerminals.getState().byProject.proj.tabs).toHaveLength(2);
  });

  it("shows a disabled state when projectId is null", () => {
    render(<TerminalWorkspace cwd="" projectId={null} visible />);
    expect(screen.getByRole("button", { name: "New terminal" })).toHaveProperty(
      "disabled",
      true
    );
  });

  it("closing a busy tab confirms first, then closes on confirm", () => {
    useTerminals.getState().openTab("proj", "/repo");
    const pane = useTerminals.getState().byProject.proj.tabs[0].panes[0].id;
    useTerminals.getState().setPaneBusy(pane, true);
    render(<TerminalWorkspace cwd="/repo" projectId="proj" visible />);
    fireEvent.click(screen.getByRole("button", { name: "Close Terminal 1" }));
    // Still open — the confirmation is showing, nothing closed yet.
    expect(useTerminals.getState().byProject.proj.tabs).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Close & stop" }));
    expect(useTerminals.getState().byProject.proj.tabs).toHaveLength(0);
  });

  it("cancelling the confirmation keeps the busy tab", () => {
    useTerminals.getState().openTab("proj", "/repo");
    const pane = useTerminals.getState().byProject.proj.tabs[0].panes[0].id;
    useTerminals.getState().setPaneBusy(pane, true);
    render(<TerminalWorkspace cwd="/repo" projectId="proj" visible />);
    fireEvent.click(screen.getByRole("button", { name: "Close Terminal 1" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(useTerminals.getState().byProject.proj.tabs).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "Close & stop" })).toBeNull();
  });

  it("closing an idle tab does not confirm", () => {
    useTerminals.getState().openTab("proj", "/repo");
    render(<TerminalWorkspace cwd="/repo" projectId="proj" visible />);
    fireEvent.click(screen.getByRole("button", { name: "Close Terminal 1" }));
    expect(useTerminals.getState().byProject.proj.tabs).toHaveLength(0);
  });
});
