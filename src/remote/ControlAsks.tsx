/**
 * "Let <device> type" (spec §7): a device asked for [Typing control] of a
 * session the person typed in just now, which the host's ten-second rule
 * kept from it. The person can hand it control at once, or not.
 */
import { type CSSProperties, useEffect, useState } from "react";
import { askWords, useControlAsks } from "../state/controlAsks.ts";
import { useSessions } from "../state/sessions.ts";
import { button } from "../theme/recipes.ts";
import { tokens } from "../theme/tokens.ts";

/** How often shown asks are checked for having gone stale. */
const TICK_MS = 1000;

const rootStyle: CSSProperties = {
  bottom: "34px",
  display: "flex",
  flexDirection: "column",
  gap: tokens.space.sm,
  position: "fixed",
  right: "16px",
  zIndex: tokens.z.overlay,
};

const askStyle: CSSProperties = {
  alignItems: "center",
  background: tokens.color.chrome.overlay,
  border: `1px solid ${tokens.color.border}`,
  borderRadius: tokens.radius.lg,
  boxShadow: tokens.shadow.toast,
  color: tokens.color.ink.primary,
  display: "flex",
  fontFamily: tokens.font.sans,
  fontSize: "12.5px",
  gap: tokens.space.sm,
  padding: "8px 10px 8px 14px",
};

export function ControlAsks() {
  const asks = useControlAsks((state) => state.asks);
  const sessions = useSessions((state) => state.sessions);
  const projects = useSessions((state) => state.projects);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (asks.length === 0) {
      return;
    }
    // Stale asks are forgotten, so the tick stops once none are left.
    const timer = setInterval(() => {
      const at = Date.now();
      useControlAsks.getState().prune(at);
      setNow(at);
    }, TICK_MS);
    return () => clearInterval(timer);
  }, [asks.length]);

  const shown = useControlAsks.getState().current(Math.max(now, Date.now()));
  if (shown.length === 0) {
    return null;
  }
  return (
    <div style={rootStyle}>
      {shown.map((ask) => (
        <div
          key={`${ask.sessionId}:${ask.deviceId}`}
          role="status"
          style={askStyle}
        >
          <span>{askWords(ask, sessions, projects)}</span>
          <button
            className="kr-hover-surface"
            onClick={() => useControlAsks.getState().dismiss(ask)}
            style={button("secondary", "sm")}
            type="button"
          >
            Not now
          </button>
          <button
            className="kr-hover-accent"
            onClick={() => useControlAsks.getState().letType(ask)}
            style={button("primary", "sm")}
            type="button"
          >
            Let {ask.deviceName} type
          </button>
        </div>
      ))}
    </div>
  );
}
