import { Info, Settings } from "lucide-react";
import { type CSSProperties, memo } from "react";
import { useLayout } from "../state/layout.ts";
import { iconButton } from "../theme/recipes.ts";
import { tokens } from "../theme/tokens.ts";
import { UpdatePill } from "../update/UpdatePill.tsx";

const footerStyle: CSSProperties = {
  alignItems: "center",
  borderTop: `1px solid ${tokens.color.line.base}`,
  display: "flex",
  flex: "none",
  gap: "2px",
  justifyContent: "flex-end",
  padding: "12px 14px",
};

/**
 * The sidebar's bottom row: the "Update available" pill, Settings and About. It used to carry an
 * open-session token total; that was dropped because no documented source
 * gives an exact one (ADR-0038).
 */
const SidebarFooter = memo(function SidebarFooter({
  onShowAbout,
}: {
  onShowAbout: () => void;
}) {
  const setView = useLayout((state) => state.setView);

  return (
    <div data-testid="sidebar-footer" style={footerStyle}>
      <UpdatePill />
      {/* Both of these came down from the deleted title bar (ADR-0023). The
          footer is where an app puts the things you reach for once a week. */}
      <div style={{ display: "flex", flex: "none", gap: "2px" }}>
        <button
          aria-label="Settings"
          className="kr-hover-surface"
          data-testid="open-settings"
          onClick={() => setView("settings")}
          style={iconButton()}
          title="Settings (⌘,)"
          type="button"
        >
          <Settings size={14} strokeWidth={1.75} />
        </button>
        <button
          aria-label="About Kriyon"
          className="kr-hover-surface"
          data-testid="open-about"
          onClick={onShowAbout}
          style={iconButton()}
          title="About Kriyon"
          type="button"
        >
          <Info size={14} strokeWidth={1.75} />
        </button>
      </div>
    </div>
  );
});

export { SidebarFooter };
