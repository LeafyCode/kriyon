import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Segmented } from "./Segmented.tsx";

/**
 * `Segmented` backs the app's primary navigation (Changes | Session) and the
 * Changes tree's own tabs, and it claims the ARIA tabs pattern by emitting
 * `role="tablist"` / `role="tab"` / `aria-selected`. That claim carries
 * keyboard obligations: exactly one tab in the tab order at a time (roving
 * tabindex), and the arrows moving between them. Without those a screen
 * reader announces "tab 2 of 2" for a control the keyboard cannot operate.
 */

const OPTIONS = [
  { label: "Session", value: "raw" },
  { label: "Changes", value: "changes" },
] as const;

function renderSegmented(value: "raw" | "changes" = "raw") {
  const onChange = vi.fn();
  render(
    <Segmented
      ariaLabel="Transcript view"
      onChange={onChange}
      options={OPTIONS}
      value={value}
    />
  );
  const list = screen.getByRole("tablist", { name: "Transcript view" });
  return { onChange, tabs: within(list).getAllByRole("tab"), list };
}

describe("Segmented", () => {
  it("renders one tab per option with the active one selected", () => {
    const { tabs } = renderSegmented();
    expect(tabs.map((tab) => tab.textContent)).toEqual(["Session", "Changes"]);
    expect(tabs[0]).toHaveAttribute("aria-selected", "true");
    expect(tabs[1]).toHaveAttribute("aria-selected", "false");
  });

  it("keeps exactly one tab in the tab order", () => {
    // Roving tabindex: Tab reaches the tablist once, then the arrows move
    // within it — not one Tab stop per segment.
    const { tabs } = renderSegmented();
    expect(tabs[0]).toHaveAttribute("tabindex", "0");
    expect(tabs[1]).toHaveAttribute("tabindex", "-1");
  });

  it("moves to the next tab on ArrowRight", () => {
    const { onChange, tabs } = renderSegmented("raw");
    fireEvent.keyDown(tabs[0], { key: "ArrowRight" });
    expect(onChange).toHaveBeenCalledWith("changes");
  });

  it("moves to the previous tab on ArrowLeft", () => {
    const { onChange, tabs } = renderSegmented("changes");
    fireEvent.keyDown(tabs[1], { key: "ArrowLeft" });
    expect(onChange).toHaveBeenCalledWith("raw");
  });

  it("wraps around at both ends", () => {
    const first = renderSegmented("raw");
    fireEvent.keyDown(first.tabs[0], { key: "ArrowLeft" });
    expect(first.onChange).toHaveBeenCalledWith("changes");
  });

  it("jumps to the ends with Home and End", () => {
    const { onChange, tabs } = renderSegmented("changes");
    fireEvent.keyDown(tabs[1], { key: "Home" });
    expect(onChange).toHaveBeenCalledWith("raw");

    onChange.mockClear();
    fireEvent.keyDown(tabs[1], { key: "End" });
    expect(onChange).toHaveBeenCalledWith("changes");
  });

  it("leaves other keys to the rest of the app", () => {
    // The terminal and the palette both listen for keys above this control;
    // swallowing anything but the tablist's own set would eat them.
    const { onChange, tabs } = renderSegmented();
    for (const key of ["ArrowUp", "ArrowDown", "k", "Escape"]) {
      fireEvent.keyDown(tabs[0], { key });
    }
    expect(onChange).not.toHaveBeenCalled();
  });

  it("still switches on click", () => {
    const { onChange, tabs } = renderSegmented();
    fireEvent.click(tabs[1]);
    expect(onChange).toHaveBeenCalledWith("changes");
  });

  it("renders a count only when there is one to show", () => {
    const onChange = vi.fn();
    render(
      <Segmented
        ariaLabel="Transcript view"
        onChange={onChange}
        options={[
          { label: "Session", value: "raw" },
          { count: 0, label: "Empty", value: "empty" },
          { count: 12, label: "Changes", value: "changes" },
        ]}
        value="raw"
      />
    );
    const tabs = screen.getAllByRole("tab");
    expect(tabs[1].textContent).toBe("Empty");
    expect(tabs[2].textContent).toBe("Changes12");
  });
});

it("a disabled segment can't be chosen and says why", () => {
  const onChange = vi.fn();
  render(
    <Segmented
      ariaLabel="View"
      onChange={onChange}
      options={[
        { label: "A", value: "a" },
        {
          disabled: true,
          label: "B",
          title: "Needs the companion",
          value: "b",
        },
      ]}
      value="a"
    />
  );
  const b = screen.getByRole("tab", { name: "B" });
  expect(b).toBeDisabled();
  expect(b).toHaveAttribute("title", "Needs the companion");
  fireEvent.click(b);
  fireEvent.keyDown(screen.getByRole("tablist"), { key: "ArrowRight" });
  expect(onChange).not.toHaveBeenCalled();
});
