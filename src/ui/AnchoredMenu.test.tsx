import { act, fireEvent, renderHook } from "@testing-library/react";
import { expect, test } from "vitest";
import { useAnchoredMenu } from "./AnchoredMenu.tsx";

test("starts closed and toggles open then closed", () => {
  const { result } = renderHook(() => useAnchoredMenu());

  expect(result.current.open).toBe(false);
  act(() => result.current.toggle());
  expect(result.current.open).toBe(true);
  act(() => result.current.toggle());
  expect(result.current.open).toBe(false);
});

test("triggerAria reflects the open state with a menu popup", () => {
  const { result } = renderHook(() => useAnchoredMenu());

  expect(result.current.triggerAria).toEqual({
    "aria-expanded": false,
    "aria-haspopup": "menu",
  });
  act(() => result.current.toggle());
  expect(result.current.triggerAria["aria-expanded"]).toBe(true);
});

test("Escape closes an open menu", () => {
  const { result } = renderHook(() => useAnchoredMenu());

  act(() => result.current.toggle());
  act(() => {
    fireEvent.keyDown(document, { key: "Escape" });
  });
  expect(result.current.open).toBe(false);
});

test("an outside pointerdown closes; a press inside the anchor does not", () => {
  const anchor = document.createElement("div");
  const inside = document.createElement("button");
  anchor.appendChild(inside);
  document.body.appendChild(anchor);

  const { result } = renderHook(() => useAnchoredMenu());
  act(() => {
    result.current.anchorRef.current = anchor;
    result.current.toggle();
  });

  // A press inside the anchor (including the trigger) leaves it open.
  act(() => {
    fireEvent.pointerDown(inside);
  });
  expect(result.current.open).toBe(true);

  // A press anywhere outside dismisses it.
  act(() => {
    fireEvent.pointerDown(document.body);
  });
  expect(result.current.open).toBe(false);

  document.body.removeChild(anchor);
});

test("close() dismisses an open menu", () => {
  const { result } = renderHook(() => useAnchoredMenu());

  act(() => result.current.toggle());
  act(() => result.current.close());
  expect(result.current.open).toBe(false);
});
