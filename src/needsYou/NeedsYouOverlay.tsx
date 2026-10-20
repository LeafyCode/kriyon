import { type CSSProperties, useEffect, useRef, useState } from "react";
import { useLayout } from "../state/layout.ts";
import { useSessions } from "../state/sessions.ts";
import { useUi } from "../state/ui.ts";
import { useNeedsYouView } from "../state/useNeedsYouView.ts";
import { overlayPanel, sectionLabel } from "../theme/recipes.ts";
import { tokens } from "../theme/tokens.ts";
import { Overlay } from "../ui/Overlay.tsx";
import { NeedsYouList } from "./NeedsYouList.tsx";

const panelStyle: CSSProperties = {
  ...overlayPanel(),
  gap: "6px",
  maxHeight: "60vh",
  overflowY: "auto",
  padding: tokens.space.md,
  width: "460px",
};

const headingStyle: CSSProperties = {
  ...sectionLabel(),
  padding: `2px ${tokens.space.md} 4px`,
};

const emptyStyle: CSSProperties = {
  color: tokens.color.ink.muted,
  fontFamily: tokens.font.sans,
  fontSize: "12.5px",
  padding: tokens.space.md,
};

/**
 * The ⌘⇧K Needs-you overlay: the same enriched list as the Command-center rail,
 * summonable from any view. Only subscribes to the open flag and the hotkey —
 * the high-churn store slices (events, activity) are subscribed to by
 * {@link NeedsYouOverlayPanel}, which mounts only while the overlay is open.
 */
export function NeedsYouOverlay() {
  const open = useUi((state) => state.needsYouOpen);
  const openNeedsYou = useUi((state) => state.openNeedsYou);

  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (
        event.key.toLowerCase() === "k" &&
        (event.metaKey || event.ctrlKey) &&
        event.shiftKey
      ) {
        event.preventDefault();
        openNeedsYou();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [openNeedsYou]);

  if (!open) {
    return null;
  }

  return <NeedsYouOverlayPanel />;
}

/**
 * The overlay's body: mounted only while open, so it naturally gets a fresh
 * `selected` on every open (no stale-selection-on-reopen trap) and only pays
 * for the events/activity subscriptions while visible. ↑↓ selects, Enter
 * focuses the session (routing to the Raw view when the ask is exact), Esc
 * closes.
 */
function NeedsYouOverlayPanel() {
  const closeNeedsYou = useUi((state) => state.closeNeedsYou);
  const activeSessionId = useSessions((state) => state.activeSessionId);
  const setActiveSession = useSessions((state) => state.setActiveSession);
  const showSessionView = useLayout((state) => state.showSessionView);
  const setTranscriptView = useLayout((state) => state.setTranscriptView);
  const { entries } = useNeedsYouView();
  const [selected, setSelected] = useState(0);

  function openEntry(id: string, exact: boolean): void {
    setActiveSession(id);
    showSessionView();
    if (exact) {
      setTranscriptView("raw");
    }
    closeNeedsYou();
  }

  // `entries` is rebuilt on every render of this panel and `openEntry` closes
  // over four store actions, so neither can sit in a dependency array without
  // re-registering the listener as often as having none did. The latest of
  // both rides a ref instead, and the window listener is installed once.
  const latest = useRef({ entries, openEntry, selected });
  latest.current = { entries, openEntry, selected };

  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      const { entries: rows, openEntry: open, selected: at } = latest.current;
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setSelected((s) => Math.min(s + 1, Math.max(rows.length - 1, 0)));
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        setSelected((s) => Math.max(s - 1, 0));
      } else if (event.key === "Enter") {
        const entry = rows[Math.min(at, rows.length - 1)];
        if (entry) {
          // Claim the key. This listens on `window` from inside `Overlay`'s
          // focus trap, so an un-prevented Enter would also activate whatever
          // control focus is sitting on in the panel.
          event.preventDefault();
          open(entry.sessionId, entry.ask?.tier === "exact");
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  return (
    <Overlay
      label="Close needs-you overlay"
      onClose={closeNeedsYou}
      paddingTop="12vh"
    >
      <div data-testid="needs-you-overlay" style={panelStyle}>
        <span style={headingStyle}>Needs you</span>
        {entries.length > 0 ? (
          <NeedsYouList
            activeSessionId={activeSessionId}
            entries={entries}
            onOpen={openEntry}
            selectedIndex={Math.min(selected, entries.length - 1)}
          />
        ) : (
          <span style={emptyStyle}>No session needs you</span>
        )}
      </div>
    </Overlay>
  );
}
