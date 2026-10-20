import {
  type CSSProperties,
  type RefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { tokens } from "../theme/tokens.ts";

/**
 * The shared chrome for an Anchored menu's popover surface: overlay fill,
 * hairline border, elevation, and the `right`/`top:100%` anchoring to its
 * container. Each adapter spreads this and adds only its own sizing (min-width,
 * padding, gap), so the color picker and the session-row menu can never drift
 * apart visually.
 */
export const anchoredMenuSurfaceStyle: CSSProperties = {
  background: tokens.color.chrome.overlay,
  border: `1px solid ${tokens.color.border}`,
  borderRadius: tokens.radius.lg,
  boxShadow: tokens.shadow.pop,
  display: "flex",
  flexDirection: "column",
  position: "absolute",
  right: "9px",
  top: "100%",
  zIndex: tokens.z.overlay,
};

/**
 * The non-modal sibling of {@link Overlay}: a lightweight popover pinned to its
 * trigger's own container. Where {@link Overlay} owns a scrim + focus trap for a
 * modal, this hook owns only the three things an anchored menu needs — open/close
 * state, Escape-to-dismiss, and outside-`pointerdown` dismissal — plus the
 * trigger's `aria-expanded`/`aria-haspopup`. The popover itself stays absolutely
 * positioned relative to the caller's existing anchor (a project header, a session
 * row), so this is a hook, not a wrapper element: wrapping the popover would
 * re-anchor it and break its `right`/`top:100%` positioning.
 *
 * A press inside the anchor (including the trigger) never dismisses — those
 * elements handle themselves; only a press outside the anchor closes it. The
 * Escape/outside listeners attach only while the menu is open.
 */
export interface AnchoredMenu<T extends HTMLElement> {
  /**
   * Put on the relative container the popover anchors to (the header / the row).
   * A `pointerdown` inside it is treated as "inside the menu" and never dismisses.
   */
  anchorRef: RefObject<T | null>;
  /** Dismiss the popover — call after a menu action commits. */
  close: () => void;
  /** Whether the popover is currently shown. */
  open: boolean;
  /** Flip the popover open/closed — wire onto the trigger's `onClick`. */
  toggle: () => void;
  /** Spread onto the trigger so screen readers announce the popover. */
  triggerAria: { "aria-expanded": boolean; "aria-haspopup": "menu" };
}

/**
 * Escape-or-press-outside dismissal, the one behavior every menu in the app
 * shares. Extracted so the anchored menu and the context menu cannot drift
 * apart on it — they differ in where they are positioned, not in how they go
 * away. Listeners attach only while `open`.
 */
export function useDismissOnOutside(
  open: boolean,
  onDismiss: () => void,
  insideRef: RefObject<HTMLElement | null>
): void {
  useEffect(() => {
    if (!open) {
      return;
    }
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        onDismiss();
      }
    };
    const onPointerDown = (event: PointerEvent) => {
      if (!insideRef.current?.contains(event.target as Node)) {
        onDismiss();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, [open, onDismiss, insideRef]);
}

export function useAnchoredMenu<
  T extends HTMLElement = HTMLDivElement,
>(): AnchoredMenu<T> {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<T | null>(null);

  // The popover dismisses like any menu: Escape, or any press outside its
  // anchoring container (a press inside — including the trigger — is handled by
  // the elements themselves).
  const dismiss = useCallback(() => setOpen(false), []);
  useDismissOnOutside(open, dismiss, anchorRef);

  return {
    anchorRef,
    close: () => setOpen(false),
    open,
    toggle: () => setOpen((v) => !v),
    triggerAria: { "aria-expanded": open, "aria-haspopup": "menu" },
  };
}
