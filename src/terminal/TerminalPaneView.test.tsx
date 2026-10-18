import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("./Terminal.tsx", () => ({
  Terminal: ({ sessionId, active }: { sessionId: string; active: boolean }) => (
    <div data-active={active} data-testid={`term-${sessionId}`} />
  ),
}));

import { TerminalPaneView } from "./TerminalPaneView.tsx";

const noop = () => {
  /* no-op */
};

describe("TerminalPaneView", () => {
  it("renders the Terminal with the pane id and forwards active", () => {
    render(
      <TerminalPaneView
        active
        cwd="/repo"
        onClose={noop}
        onFocus={noop}
        onSplit={noop}
        paneId="pane-1"
        showControls
      />
    );
    const term = screen.getByTestId("term-pane-1");
    expect(term.getAttribute("data-active")).toBe("true");
  });

  it("tells the focused pane's label apart from an unfocused one's", () => {
    // In a split, the header fill alone is a 6% step on a flat plane. The
    // label's ink is the other half of that distinction, and it was lost to a
    // ternary that returned the same stop on both branches. Both stops must
    // stay `ink.muted` or brighter — ADR-0023's AA rule for anything the user
    // reads.
    const paneLabel = (active: boolean) => {
      const view = render(
        <TerminalPaneView
          active={active}
          cwd="/repo/workspace"
          onClose={noop}
          onFocus={noop}
          onSplit={noop}
          paneId="pane-1"
          showControls
        />
      );
      const label = screen.getByTitle("/repo/workspace");
      const { color } = label.style;
      view.unmount();
      return color;
    };

    expect(paneLabel(true)).not.toBe(paneLabel(false));
  });

  it("fires onSplit and onClose from the header controls", () => {
    const onSplit = vi.fn();
    const onClose = vi.fn();
    render(
      <TerminalPaneView
        active
        cwd="/repo"
        onClose={onClose}
        onFocus={noop}
        onSplit={onSplit}
        paneId="pane-1"
        showControls
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "Split pane" }));
    fireEvent.click(screen.getByRole("button", { name: "Close pane" }));
    expect(onSplit).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("hides controls when showControls is false", () => {
    render(
      <TerminalPaneView
        active
        cwd="/repo"
        onClose={noop}
        onFocus={noop}
        onSplit={noop}
        paneId="pane-1"
        showControls={false}
      />
    );
    expect(screen.queryByRole("button", { name: "Split pane" })).toBeNull();
  });

  // The end of the silently-wedged pane: a dead shell shows an overlay with a
  // restart affordance instead of a frozen prompt that swallows keystrokes.
  it("shows the Shell exited overlay and fires onRestart when dead", () => {
    const onRestart = vi.fn();
    render(
      <TerminalPaneView
        active
        cwd="/repo"
        dead
        onClose={noop}
        onFocus={noop}
        onRestart={onRestart}
        onSplit={noop}
        paneId="pane-1"
        showControls
      />
    );
    expect(screen.getByText("Shell exited")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Restart shell" }));
    expect(onRestart).toHaveBeenCalledTimes(1);
  });

  it("shows no overlay while the shell is alive", () => {
    render(
      <TerminalPaneView
        active
        cwd="/repo"
        onClose={noop}
        onFocus={noop}
        onSplit={noop}
        paneId="pane-1"
        showControls
      />
    );
    expect(screen.queryByText("Shell exited")).toBeNull();
  });
});
