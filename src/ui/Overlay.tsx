import type { CSSProperties, ReactNode } from "react";
import { useEffect, useRef } from "react";
import { tokens } from "../theme/tokens.ts";

/**
 * The shared shell every modal overlay sits in: a fixed, scrimmed container
 * with a centered panel. It owns the three things every overlay used to
 * hand-roll — the scrim backdrop (click to close), the Escape key, and a focus
 * trap that keeps Tab inside the panel and restores focus on unmount — so a new
 * overlay is one `<Overlay>` wrapper, not thirty copied lines.
 *
 * The caller supplies only the panel (its own width, height, and chrome). The
 * scrim comes from {@link tokens.color.scrim} so overlays can never drift apart.
 */
export interface OverlayProps {
  /** Vertical placement: `top` pads from the top (default), `center` centers. */
  align?: "top" | "center";
  /** Optional test id on the backdrop button. */
  backdropTestId?: string;
  /** Panel contents. Its own styling stays with the caller. */
  children: ReactNode;
  /** Accessible name for the scrim close button, e.g. "Close command palette". */
  label: string;
  /** Called on backdrop click and (unless {@link onEscape} is set) on Escape. */
  onClose: () => void;
  /**
   * Escape handler, when it must differ from a plain close — e.g. the prompt
   * picker steps back a stage before closing. Defaults to {@link onClose}.
   */
  onEscape?: () => void;
  /** Top padding when `align` is `top`. Defaults to `14vh`. */
  paddingTop?: string;
}

const backdropStyle: CSSProperties = {
  background: tokens.color.scrim,
  backdropFilter: tokens.blur.overlay,
  WebkitBackdropFilter: tokens.blur.overlay,
  border: "none",
  cursor: "default",
  inset: 0,
  padding: 0,
  position: "absolute",
};

const FOCUSABLE =
  'a[href],button:not([disabled]),textarea:not([disabled]),input:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])';

function focusableIn(root: HTMLElement | null): HTMLElement[] {
  if (!root) {
    return [];
  }
  // `:not([disabled])` in the selector already drops disabled controls; hidden
  // subtrees are excluded via the `hidden` attribute. (offsetParent-based
  // visibility checks can't be used — jsdom always reports null.)
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) => !el.closest("[hidden]")
  );
}

export function Overlay({
  children,
  label,
  onClose,
  onEscape,
  align = "top",
  paddingTop = "14vh",
  backdropTestId,
}: OverlayProps) {
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    // Move focus into the panel so Tab starts trapped and screen readers land
    // inside the overlay. Prefer the first focusable; fall back to the panel.
    const initial = focusableIn(panelRef.current);
    (initial[0] ?? panelRef.current)?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        (onEscape ?? onClose)();
        return;
      }
      if (event.key !== "Tab") {
        return;
      }
      const items = focusableIn(panelRef.current);
      if (items.length === 0) {
        event.preventDefault();
        panelRef.current?.focus();
        return;
      }
      const [first] = items;
      // biome-ignore lint/style/useAtIndex: project lib is ES2020; Array.prototype.at is unavailable.
      const last = items[items.length - 1];
      const active = document.activeElement;
      if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      // Guarded like ContextMenu's own focus restore: the opener can be gone
      // by the time this overlay closes (e.g. deleting a file-tree row via
      // its ConfirmDialog detaches the button that opened it), and focusing a
      // detached element is a silent no-op that strands the user on
      // `document.body` instead of falling back sensibly.
      if (
        previouslyFocused instanceof HTMLElement &&
        document.contains(previouslyFocused)
      ) {
        previouslyFocused.focus();
      }
    };
  }, [onClose, onEscape]);

  const containerStyle: CSSProperties = {
    alignItems: align === "center" ? "center" : "flex-start",
    display: "flex",
    inset: 0,
    justifyContent: "center",
    paddingTop: align === "center" ? undefined : paddingTop,
    position: "fixed",
    zIndex: tokens.z.overlay,
  };

  return (
    <div style={containerStyle}>
      <button
        aria-label={label}
        data-testid={backdropTestId}
        onClick={onClose}
        style={backdropStyle}
        type="button"
      />
      <div ref={panelRef} style={{ position: "relative", zIndex: 1 }}>
        {children}
      </div>
    </div>
  );
}
