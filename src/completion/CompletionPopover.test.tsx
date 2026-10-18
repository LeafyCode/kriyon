import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CompletionPopover } from "./CompletionPopover.tsx";

describe("CompletionPopover", () => {
  it("renders rows and highlights the active one", () => {
    render(
      <CompletionPopover
        activeIndex={1}
        onPick={() => undefined}
        rows={[
          { primary: "/clear", secondary: "Clear history" },
          { primary: "/compact" },
        ]}
      />
    );
    expect(screen.getByText("/clear")).toBeInTheDocument();
    const active = screen.getByText("/compact").closest("[data-active]");
    expect(active).toHaveAttribute("data-active", "true");
  });

  it("calls onPick with the row index when clicked", () => {
    const onPick = vi.fn();
    render(
      <CompletionPopover
        activeIndex={0}
        onPick={onPick}
        rows={[{ primary: "a" }, { primary: "b" }]}
      />
    );
    fireEvent.mouseDown(screen.getByText("b"));
    expect(onPick).toHaveBeenCalledWith(1);
  });

  it("renders nothing when there are no rows", () => {
    const { container } = render(
      <CompletionPopover activeIndex={0} onPick={() => undefined} rows={[]} />
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("portals the listbox to document.body so an overflow:hidden ancestor can't clip it", () => {
    const { container } = render(
      <CompletionPopover
        activeIndex={0}
        onPick={() => undefined}
        rows={[{ primary: "/clear" }]}
      />
    );
    // Not a descendant of the render container...
    expect(container.querySelector('[role="listbox"]')).toBeNull();
    // ...but present as a child of document.body.
    expect(document.body.querySelector('[role="listbox"]')).toBeTruthy();
  });
});
