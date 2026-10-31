import { ChevronRight } from "lucide-react";
import { type CSSProperties, memo, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { parkedProjectIds, useSessions } from "../state/sessions.ts";
import { button } from "../theme/recipes.ts";
import { tokens } from "../theme/tokens.ts";

// Quiet, collapsed-by-default disclosure — same muted/hairline language as
// the project group header, but never expanded on load: archived sessions
// are deliberately out of the way until asked for.
const archivedHeaderStyle: CSSProperties = {
  alignItems: "center",
  background: "transparent",
  border: "none",
  borderTop: `1px solid ${tokens.color.line.soft}`,
  color: tokens.color.ink.muted,
  cursor: "pointer",
  display: "flex",
  fontFamily: tokens.font.sans,
  fontSize: "11.5px",
  gap: "6px",
  padding: "8px 8px 6px",
  width: "100%",
};

const archivedRowStyle: CSSProperties = {
  alignItems: "center",
  display: "flex",
  gap: "8px",
  justifyContent: "space-between",
  padding: "5px 8px 5px 20px",
};

const archivedTitleStyle: CSSProperties = {
  color: tokens.color.ink.muted,
  flex: 1,
  fontSize: "12.5px",
  minWidth: 0,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const unarchiveButtonStyle: CSSProperties = {
  ...button("secondary", "sm"),
  fontSize: "10.5px",
  height: "20px",
  padding: "0 8px",
};

/**
 * A collapsed-by-default group listing every archived session across all
 * projects, with a one-click "Restore" back to the active surfaces. Reads
 * `sessions` directly (not per-project) since archived sessions have already
 * left their {@link ProjectGroup}.
 */
const ArchivedGroup = memo(function ArchivedGroup() {
  // A [Parked project]'s archived sessions go with it: restoring one here
  // would put it back into a project that is still out of sight.
  const archived = useSessions(
    useShallow((state) => {
      const parked = parkedProjectIds(state.projects);
      return Object.values(state.sessions).filter(
        (s) => s.archivedAt !== null && !parked.has(s.projectId)
      );
    })
  );
  const [open, setOpen] = useState(false);
  if (archived.length === 0) {
    return null;
  }
  return (
    <div data-testid="archived-group" style={{ marginTop: tokens.space.md }}>
      <button
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        style={archivedHeaderStyle}
        type="button"
      >
        <ChevronRight
          size={9}
          strokeWidth={2}
          style={{
            color: tokens.color.ink.faint,
            flex: "none",
            transform: open ? "rotate(90deg)" : "none",
            transition: `transform ${tokens.motion.disclose}`,
          }}
        />
        Archived ({archived.length})
      </button>
      {open
        ? archived.map((s) => (
            <div key={s.id} style={archivedRowStyle}>
              <span style={archivedTitleStyle}>{s.title}</span>
              <button
                aria-label={`Unarchive ${s.title}`}
                className="kr-hover-surface"
                data-testid={`unarchive-${s.id}`}
                onClick={() => useSessions.getState().unarchiveSession(s.id)}
                style={unarchiveButtonStyle}
                type="button"
              >
                Restore
              </button>
            </div>
          ))
        : null}
    </div>
  );
});

export { ArchivedGroup };
