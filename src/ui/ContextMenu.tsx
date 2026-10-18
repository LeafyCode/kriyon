import {
  type CSSProperties,
  type KeyboardEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { row30 } from "../theme/recipes.ts";
import { tokens } from "../theme/tokens.ts";
import {
  anchoredMenuSurfaceStyle,
  useDismissOnOutside,
} from "./AnchoredMenu.tsx";

/** How far from the viewport edge the menu refuses to sit. */
const EDGE_MARGIN = Number.parseInt(tokens.space.sm, 10);

export interface ContextMenuItem {
  /** Renders in the destructive ink, below a separator. */
  danger?: boolean;
  label: string;
  onSelect: () => void;
  /** Draws a divider above this item — the explicit grouping cue for lists
   * whose structure the automatic danger separator alone can't carry. */
  separatorBefore?: boolean;
}

const surfaceStyle: CSSProperties = {
  ...anchoredMenuSurfaceStyle,
  // The anchored variant pins itself to a container; this one is placed from
  // the pointer, so the container-relative offsets have to go.
  gap: tokens.space.xs,
  // No token in tokens.space reaches a popover width — the scale tops out at
  // `xl` (24px), which is spacing between elements, not a menu's own size.
  // 168 sits on the same 4px rhythm the scale is built from, so it isn't the
  // kind of arbitrary value the rule is guarding against; it's just not a
  // named step. Matches the sibling anchored menu's own un-tokenized
  // `minWidth` (`SessionRow.tsx`'s `menuSurfaceStyle`).
  minWidth: "168px",
  padding: tokens.space.xs,
  right: "auto",
  top: "auto",
};

const itemStyle: CSSProperties = {
  ...row30(),
  background: "none",
  border: "none",
  color: tokens.color.ink.primary,
  cursor: "pointer",
  textAlign: "left",
  width: "100%",
};

const dangerItemStyle: CSSProperties = {
  ...itemStyle,
  color: tokens.color.status.error,
};

const separatorStyle: CSSProperties = {
  background: tokens.color.line.soft,
  height: "1px",
  margin: `${tokens.space.xs} 0`,
};

/**
 * A menu opened at the pointer — the right-click companion to
 * {@link useAnchoredMenu}, which pins itself to a container instead.
 *
 * Positioning is measured after mount rather than guessed: the menu's own size
 * is not known until it renders, and "would this overflow the viewport" cannot
 * be answered without it. It renders at the raw pointer position for one frame
 * with `visibility: hidden`, then commits the corrected position — which is why
 * the flip is a `useLayoutEffect` and not a `useEffect` (the latter would paint
 * the uncorrected position first).
 */
export function ContextMenu({
  at,
  items,
  label,
  onClose,
}: {
  at: { x: number; y: number };
  items: ContextMenuItem[];
  label: string;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [placed, setPlaced] = useState<
    { left: number; top: number } | undefined
  >(undefined);

  // `onClose` is held in a ref, not passed to the dismissal hook directly, so
  // a caller that hands in a fresh arrow function on every render (Task 5
  // wires this to real tree rows) can never make the hook's effect tear down
  // and re-attach its document listeners mid-gesture — which could otherwise
  // miss the very pointerdown meant to close the menu. `dismiss` itself is
  // referentially stable across the component's whole lifetime.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const dismiss = useCallback(() => onCloseRef.current(), []);

  useDismissOnOutside(true, dismiss, ref);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) {
      return;
    }
    const { height, width } = el.getBoundingClientRect();
    const left =
      at.x + width + EDGE_MARGIN > window.innerWidth
        ? Math.max(EDGE_MARGIN, at.x - width)
        : at.x;
    const top =
      at.y + height + EDGE_MARGIN > window.innerHeight
        ? Math.max(EDGE_MARGIN, at.y - height)
        : at.y;
    setPlaced({ left, top });
  }, [at.x, at.y]);

  // Focus lands on the first item so the menu is usable from the keyboard the
  // moment it opens, and returns to wherever it was when the menu goes away —
  // Escape, running an item, and an outside click all work by unmounting the
  // menu, so one cleanup here covers all three. Without this a keyboard user
  // is stranded on `document.body` the moment they dismiss the menu; Task 5
  // wires this to real file-tree rows, so that's a real loss of place, not a
  // theoretical one. Guarded against the element having left the DOM (e.g. the
  // row that opened the menu was itself deleted while it was open).
  useEffect(() => {
    const previouslyFocused = document.activeElement;
    ref.current?.querySelector<HTMLButtonElement>("[role='menuitem']")?.focus();
    return () => {
      if (
        previouslyFocused instanceof HTMLElement &&
        document.contains(previouslyFocused)
      ) {
        previouslyFocused.focus();
      }
    };
  }, []);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") {
      return;
    }
    event.preventDefault();
    const buttons = Array.from(
      ref.current?.querySelectorAll<HTMLButtonElement>("[role='menuitem']") ??
        []
    );
    const here = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const step = event.key === "ArrowDown" ? 1 : -1;
    const next = (here + step + buttons.length) % buttons.length;
    buttons[next]?.focus();
  };

  return (
    <div
      aria-label={label}
      onKeyDown={onKeyDown}
      ref={ref}
      role="menu"
      style={{
        ...surfaceStyle,
        left: `${placed?.left ?? at.x}px`,
        position: "fixed",
        top: `${placed?.top ?? at.y}px`,
        visibility: placed ? "visible" : "hidden",
      }}
    >
      {items.map((item, index) => (
        // `role="none"`: without it this wrapper is a non-`menuitem` child of
        // `role="menu"`, which puts it in the accessible tree between the
        // menu and its items — screen readers then report a nesting level
        // the menu doesn't actually have. `role="none"` (equivalent to
        // `role="presentation"`) strips the `<div>` itself out of that tree
        // while leaving its DOM structure — and the `key` React needs —
        // untouched.
        <div key={item.label} role="none">
          {index > 0 &&
          (item.separatorBefore === true ||
            (item.danger && !items[index - 1]?.danger)) ? (
            // Purely a visual grouping cue, not a semantic boundary — the
            // menu's own item order and each item's `data-danger` already
            // carry the real structure, so this stays out of the a11y tree
            // rather than claiming `role="separator"` (which Biome's
            // useAriaPropsForRole rule then requires `aria-valuenow` for,
            // meaningless on a static, non-focusable divider).
            <div
              aria-hidden="true"
              data-testid="context-menu-separator"
              style={separatorStyle}
            />
          ) : null}
          <button
            data-danger={item.danger === true}
            onClick={() => {
              item.onSelect();
              onClose();
            }}
            role="menuitem"
            style={item.danger ? dangerItemStyle : itemStyle}
            type="button"
          >
            {item.label}
          </button>
        </div>
      ))}
    </div>
  );
}
