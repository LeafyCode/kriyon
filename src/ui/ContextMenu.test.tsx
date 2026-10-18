import { fireEvent, render, screen } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { ContextMenu } from "./ContextMenu.tsx";

const NEW_FILE_RE = /new file/i;
const DELETE_RE = /delete/i;

function renderMenu(
  overrides: Partial<Parameters<typeof ContextMenu>[0]> = {}
) {
  const onClose = vi.fn();
  const onSelect = vi.fn();
  render(
    <ContextMenu
      at={{ x: 40, y: 60 }}
      items={[
        { label: "New File", onSelect },
        { danger: true, label: "Delete", onSelect: vi.fn() },
      ]}
      label="File actions"
      onClose={onClose}
      {...overrides}
    />
  );
  return { onClose, onSelect };
}

test("opens at the pointer position", () => {
  renderMenu();

  const menu = screen.getByRole("menu", { name: "File actions" });
  expect(menu).toHaveStyle({ left: "40px", top: "60px" });
});

/** MINOR 5 (final review): each `menuitem` used to sit inside a bare `<div>`
 * — a non-`menuitem` child of `role="menu"` — which puts it in the menu's
 * accessible tree between the menu and its items. `role="none"` takes the
 * wrapper back out of that tree without touching its DOM structure. */
test("every item's wrapper is out of the menu's accessible tree", () => {
  renderMenu();

  const menu = screen.getByRole("menu", { name: "File actions" });
  const wrappers = Array.from(menu.children);
  expect(wrappers).toHaveLength(2);
  for (const wrapper of wrappers) {
    expect(wrapper).toHaveAttribute("role", "none");
  }
});

test("running an item closes the menu", () => {
  const { onClose, onSelect } = renderMenu();

  fireEvent.click(screen.getByRole("menuitem", { name: NEW_FILE_RE }));

  expect(onSelect).toHaveBeenCalledTimes(1);
  expect(onClose).toHaveBeenCalledTimes(1);
});

test("Escape dismisses without running anything", () => {
  const { onClose, onSelect } = renderMenu();

  fireEvent.keyDown(document, { key: "Escape" });

  expect(onClose).toHaveBeenCalledTimes(1);
  expect(onSelect).not.toHaveBeenCalled();
});

test("a press outside dismisses", () => {
  const { onClose } = renderMenu();

  fireEvent.pointerDown(document.body);

  expect(onClose).toHaveBeenCalledTimes(1);
});

test("arrow keys move focus between items", () => {
  renderMenu();
  const items = screen.getAllByRole("menuitem");
  expect(items[0]).toHaveFocus();

  fireEvent.keyDown(items[0], { key: "ArrowDown" });

  expect(items[1]).toHaveFocus();
});

/**
 * A menu opened near the right/bottom edge must not render off-screen.
 *
 * jsdom's `getBoundingClientRect` always returns a zeroed rect, so the
 * production overflow check (`at.x + width + EDGE_MARGIN > innerWidth`) would
 * see a 0-width menu and never trip — and even if it did, subtracting 0 would
 * leave the coordinate unchanged, so a naive "is it different" assertion would
 * pass without the flip logic ever running. Stub the rect to a realistic menu
 * size so the overflow branch actually executes, and assert the exact flipped
 * coordinates rather than merely "not the input value".
 */
const MENU_RECT_SIZE = { height: 120, width: 180 };

test("flips away from the viewport edge", () => {
  const rectSpy = vi
    .spyOn(HTMLElement.prototype, "getBoundingClientRect")
    .mockReturnValue({
      bottom: 0,
      height: MENU_RECT_SIZE.height,
      left: 0,
      right: 0,
      toJSON() {
        return this;
      },
      top: 0,
      width: MENU_RECT_SIZE.width,
      x: 0,
      y: 0,
    });

  try {
    const at = { x: window.innerWidth - 4, y: window.innerHeight - 4 };
    renderMenu({ at });

    const menu = screen.getByRole("menu", { name: "File actions" });

    expect(menu.style.left).toBe(`${at.x - MENU_RECT_SIZE.width}px`);
    expect(menu.style.top).toBe(`${at.y - MENU_RECT_SIZE.height}px`);
  } finally {
    rectSpy.mockRestore();
  }
});

test("marks the destructive item so it does not read like the others", () => {
  renderMenu();

  expect(screen.getByRole("menuitem", { name: DELETE_RE })).toHaveAttribute(
    "data-danger",
    "true"
  );
});

test("groups consecutive destructive items behind one separator, not one each", () => {
  renderMenu({
    items: [
      { label: "Rename", onSelect: vi.fn() },
      { danger: true, label: "Delete", onSelect: vi.fn() },
      { danger: true, label: "Discard", onSelect: vi.fn() },
    ],
  });

  expect(screen.getAllByTestId("context-menu-separator")).toHaveLength(1);
});

test("a list starting with a destructive item gets no phantom separator above it", () => {
  renderMenu({
    items: [
      { danger: true, label: "Delete", onSelect: vi.fn() },
      { danger: true, label: "Discard", onSelect: vi.fn() },
    ],
  });

  expect(screen.queryAllByTestId("context-menu-separator")).toHaveLength(0);
});

test("an explicit separatorBefore draws a divider above its item", () => {
  renderMenu({
    items: [
      { label: "New File", onSelect: vi.fn() },
      { label: "Copy Path", onSelect: vi.fn(), separatorBefore: true },
      { danger: true, label: "Delete", onSelect: vi.fn() },
    ],
  });

  // One explicit divider before Copy Path, plus the automatic one the danger
  // block always gets — the two rules compose rather than replace each other.
  expect(screen.getAllByTestId("context-menu-separator")).toHaveLength(2);
});

test("separatorBefore on the first item draws nothing", () => {
  renderMenu({
    items: [
      { label: "Copy Path", onSelect: vi.fn(), separatorBefore: true },
      { label: "New File", onSelect: vi.fn() },
    ],
  });

  expect(screen.queryAllByTestId("context-menu-separator")).toHaveLength(0);
});

test("closing returns focus to what was focused before the menu opened", () => {
  const opener = document.createElement("button");
  document.body.appendChild(opener);
  opener.focus();
  expect(opener).toHaveFocus();

  const onClose = vi.fn();
  const { unmount } = render(
    <ContextMenu
      at={{ x: 40, y: 60 }}
      items={[{ label: "New File", onSelect: vi.fn() }]}
      label="File actions"
      onClose={() => {
        onClose();
        unmount();
      }}
    />
  );
  expect(screen.getByRole("menuitem")).toHaveFocus();

  fireEvent.keyDown(document, { key: "Escape" });

  expect(onClose).toHaveBeenCalledTimes(1);
  expect(opener).toHaveFocus();
  document.body.removeChild(opener);
});
