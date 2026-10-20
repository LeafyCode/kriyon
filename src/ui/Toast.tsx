/**
 * Minimal transient toast. A module-level pub/sub lets any module (e.g. the
 * terminal copy handler) fire a message without threading callbacks through the
 * component tree; the single mounted {@link Toast} renders the latest message
 * and auto-dismisses it.
 *
 * Two kinds: "success" (the default, so the many existing informational call
 * sites don't have to change) and "error" — a failure gets a distinct glyph,
 * the status-error ink, `role="alert"` (screen readers interrupt for it,
 * unlike `role="status"`), and a longer auto-dismiss so it's actually
 * readable rather than flashing by at the same 1.5s a success tick gets.
 */
import { type CSSProperties, useEffect, useState } from "react";
import { tokens } from "../theme/tokens.ts";

export type ToastKind = "success" | "error";

const AUTO_DISMISS_MS: Record<ToastKind, number> = {
  error: 5000,
  success: 1500,
};

interface ToastState {
  kind: ToastKind;
  message: string;
}

type Listener = (toast: ToastState) => void;

const listeners = new Set<Listener>();

/** Fire a transient toast with `message`. `kind` defaults to "success". */
export function showToast(message: string, kind: ToastKind = "success"): void {
  for (const listener of listeners) {
    listener({ kind, message });
  }
}

const rootStyle: CSSProperties = {
  alignItems: "center",
  animation: "kr-pop-in 0.16s ease both",
  background: tokens.color.chrome.overlay,
  border: `1px solid ${tokens.color.border}`,
  borderRadius: tokens.radius.lg,
  bottom: "34px",
  boxShadow: tokens.shadow.toast,
  color: tokens.color.ink.primary,
  display: "flex",
  fontFamily: tokens.font.sans,
  fontSize: "12.5px",
  gap: "9px",
  left: "50%",
  padding: "10px 16px",
  pointerEvents: "none",
  position: "fixed",
  transform: "translateX(-50%)",
  zIndex: tokens.z.toast,
};

function glyph(kind: ToastKind): string {
  return kind === "error" ? "✕" : "✓";
}

/**
 * The canvas marks state with a coloured dot, and this deliberately doesn't:
 * a dot would leave success and failure distinguishable *only* by hue. The
 * glyph stays — recoloured to the new status inks and dropped to the meta
 * size so it reads as a marker beside the message rather than a second word.
 */
function glyphStyle(kind: ToastKind): CSSProperties {
  return {
    color:
      kind === "error" ? tokens.color.status.error : tokens.color.status.done,
    flex: "none",
    fontSize: "11px",
    lineHeight: 1,
  };
}

export function Toast() {
  const [toast, setToast] = useState<ToastState | undefined>(undefined);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const listener: Listener = (next) => {
      setToast(next);
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      timer = setTimeout(() => setToast(undefined), AUTO_DISMISS_MS[next.kind]);
    };
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    };
  }, []);

  if (toast === undefined) {
    return null;
  }

  return (
    <div role={toast.kind === "error" ? "alert" : "status"} style={rootStyle}>
      <span style={glyphStyle(toast.kind)}>{glyph(toast.kind)}</span>
      {toast.message}
    </div>
  );
}
