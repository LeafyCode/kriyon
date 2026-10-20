import { fireEvent, render, screen } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { Overlay } from "./Overlay.tsx";

test("renders the panel children", () => {
  render(
    <Overlay label="Close" onClose={() => undefined}>
      <div>panel body</div>
    </Overlay>
  );
  expect(screen.getByText("panel body")).toBeInTheDocument();
});

test("clicking the scrim backdrop closes", () => {
  const onClose = vi.fn();
  render(
    <Overlay backdropTestId="bd" label="Close me" onClose={onClose}>
      <button type="button">inside</button>
    </Overlay>
  );
  fireEvent.click(screen.getByTestId("bd"));
  expect(onClose).toHaveBeenCalledTimes(1);
});

test("Escape closes by default", () => {
  const onClose = vi.fn();
  render(
    <Overlay label="Close" onClose={onClose}>
      <button type="button">inside</button>
    </Overlay>
  );
  fireEvent.keyDown(window, { key: "Escape" });
  expect(onClose).toHaveBeenCalledTimes(1);
});

test("Escape routes to onEscape when provided, not onClose", () => {
  const onClose = vi.fn();
  const onEscape = vi.fn();
  render(
    <Overlay label="Close" onClose={onClose} onEscape={onEscape}>
      <button type="button">inside</button>
    </Overlay>
  );
  fireEvent.keyDown(window, { key: "Escape" });
  expect(onEscape).toHaveBeenCalledTimes(1);
  expect(onClose).not.toHaveBeenCalled();
});

test("Tab wraps from the last focusable back to the first", () => {
  render(
    <Overlay label="Close" onClose={() => undefined}>
      <button type="button">first</button>
      <button type="button">last</button>
    </Overlay>
  );
  const last = screen.getByText("last");
  last.focus();
  fireEvent.keyDown(window, { key: "Tab" });
  expect(document.activeElement).toBe(screen.getByText("first"));
});

test("Shift+Tab wraps from the first focusable back to the last", () => {
  render(
    <Overlay label="Close" onClose={() => undefined}>
      <button type="button">first</button>
      <button type="button">last</button>
    </Overlay>
  );
  const first = screen.getByText("first");
  first.focus();
  fireEvent.keyDown(window, { key: "Tab", shiftKey: true });
  expect(document.activeElement).toBe(screen.getByText("last"));
});

test("restores focus to the previously focused element on unmount", () => {
  render(
    <button data-testid="opener" type="button">
      opener
    </button>
  );
  const opener = screen.getByTestId("opener");
  opener.focus();
  expect(document.activeElement).toBe(opener);

  const { unmount } = render(
    <Overlay label="Close" onClose={() => undefined}>
      <button type="button">inside</button>
    </Overlay>
  );
  unmount();
  expect(document.activeElement).toBe(opener);
});

test("does not throw restoring focus to an opener removed from the DOM", () => {
  const opener = document.createElement("button");
  document.body.appendChild(opener);
  opener.focus();
  expect(document.activeElement).toBe(opener);

  const { unmount } = render(
    <Overlay label="Close" onClose={() => undefined}>
      <button type="button">inside</button>
    </Overlay>
  );

  // Simulate the opener's row being deleted while the overlay is still open
  // (e.g. a ConfirmDialog inside a file-tree row).
  document.body.removeChild(opener);

  expect(() => unmount()).not.toThrow();
  expect(document.activeElement).not.toBe(opener);
});
