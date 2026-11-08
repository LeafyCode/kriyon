/**
 * A [Project folder]'s block on the rail: a header (chevron, folder mark,
 * name, a needs-you dot while collapsed, a project count, and a ⋯ menu) over
 * its project groups. Plus the [Folder focus] banner that names the folder the
 * rail is narrowed to. Sorting only — nothing here stops or starts work.
 */
import {
  ChevronRight,
  Crosshair,
  Folder,
  MoreHorizontal,
  X,
} from "lucide-react";
import type { CSSProperties, ReactNode } from "react";
import { useLayout } from "../state/layout.ts";
import {
  deleteProjectFolder,
  type ProjectFolder,
  renameProjectFolder,
  useProjectFolders,
} from "../state/projectFolders.ts";
import { isPutAway, useSessions } from "../state/sessions.ts";
import { sectionLabel } from "../theme/recipes.ts";
import { accentAlpha, tokens } from "../theme/tokens.ts";
import {
  anchoredMenuSurfaceStyle,
  useAnchoredMenu,
} from "../ui/AnchoredMenu.tsx";
import { HeaderAction } from "./HeaderAction.tsx";
import { InlineRename } from "./InlineRename.tsx";

const headerStyle: CSSProperties = {
  alignItems: "center",
  display: "flex",
  gap: "2px",
  position: "relative",
};

const headerButtonStyle: CSSProperties = {
  alignItems: "center",
  background: "transparent",
  border: "none",
  borderRadius: tokens.radius.md,
  color: tokens.color.ink.secondary,
  cursor: "pointer",
  display: "flex",
  flex: 1,
  fontFamily: tokens.font.sans,
  fontSize: "11.5px",
  fontWeight: 600,
  gap: "7px",
  letterSpacing: "0.02em",
  minWidth: 0,
  padding: "6px 8px",
  textAlign: "left",
};

function chevronStyle(expanded: boolean): CSSProperties {
  return {
    alignItems: "center",
    color: tokens.color.ink.faint,
    display: "flex",
    flex: "none",
    transform: expanded ? "rotate(90deg)" : "none",
    transition: `transform ${tokens.motion.disclose}`,
  };
}

const nameStyle: CSSProperties = {
  flex: 1,
  minWidth: 0,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const countStyle: CSSProperties = {
  color: tokens.color.ink.muted,
  flex: "none",
  fontFamily: tokens.font.mono,
  fontSize: "10.5px",
};

const attentionDotStyle: CSSProperties = {
  background: tokens.color.status.waiting,
  borderRadius: "50%",
  flex: "none",
  height: "6px",
  width: "6px",
};

/** The folder's projects sit one step in, on a hairline, so the block has a
 *  visible start and end against the loose projects below it. */
const childrenStyle: CSSProperties = {
  borderLeft: `1px solid ${tokens.color.line.soft}`,
  display: "flex",
  flexDirection: "column",
  marginBottom: "4px",
  marginLeft: "14px",
  paddingLeft: "4px",
};

const emptyHintStyle: CSSProperties = {
  color: tokens.color.ink.muted,
  fontSize: "11.5px",
  lineHeight: 1.5,
  padding: "4px 8px 6px",
};

const menuSurfaceStyle: CSSProperties = {
  ...anchoredMenuSurfaceStyle,
  padding: "4px",
  width: "186px",
};

const menuItemStyle: CSSProperties = {
  background: "transparent",
  border: "none",
  borderRadius: tokens.radius.sm,
  color: tokens.color.ink.primary,
  cursor: "pointer",
  display: "flex",
  fontFamily: tokens.font.sans,
  fontSize: "12px",
  padding: "6px 8px",
  textAlign: "left",
  width: "100%",
};

const menuDividerStyle: CSSProperties = {
  border: "none",
  borderTop: `1px solid ${tokens.color.line.soft}`,
  margin: "4px 0",
};

interface FolderGroupProps {
  children: ReactNode;
  /** Some project belongs to it, even if none is on the rail right now. */
  filled: boolean;
  folder: ProjectFolder;
  /** The folder's projects on the rail, for the count and the needs-you dot. */
  projectIds: string[];
}

export function FolderGroup({
  children,
  filled,
  folder,
  projectIds,
}: FolderGroupProps) {
  const collapsed = useLayout((state) =>
    state.layout.collapsedFolderIds.includes(folder.id)
  );
  const focused = useLayout(
    (state) => state.layout.focusedFolderId === folder.id
  );
  const editing = useProjectFolders(
    (state) => state.editingFolderId === folder.id
  );
  const attention = useSessions((state) =>
    Object.values(state.sessions).some(
      (session) =>
        projectIds.includes(session.projectId) &&
        (session.status === "waiting" || session.status === "error") &&
        !isPutAway(session)
    )
  );
  const menu = useAnchoredMenu<HTMLDivElement>();
  const stopEditing = () => useProjectFolders.getState().setEditingFolder(null);
  const expanded = focused || !collapsed;

  return (
    <section
      aria-label={`Folder ${folder.name}`}
      data-testid={`folder-${folder.id}`}
    >
      <div
        className="kr-reveal-parent"
        ref={menu.anchorRef}
        style={headerStyle}
      >
        {editing ? (
          <span style={{ ...headerButtonStyle, cursor: "default" }}>
            <span style={chevronStyle(expanded)}>
              <ChevronRight size={11} />
            </span>
            <Folder color={tokens.color.ink.muted} size={12} />
            <InlineRename
              ariaLabel="Folder name"
              onCancel={stopEditing}
              onCommit={(next) => {
                stopEditing();
                renameProjectFolder(folder.id, next);
              }}
              style={{ fontSize: "11.5px", fontWeight: 600 }}
              testId={`folder-name-${folder.id}`}
              value={folder.name}
            />
          </span>
        ) : (
          <button
            aria-expanded={expanded}
            className="kr-hover-surface"
            data-testid={`folder-header-${folder.id}`}
            disabled={focused}
            onClick={() =>
              useLayout.getState().toggleFolderCollapsed(folder.id)
            }
            onContextMenu={(event) => {
              event.preventDefault();
              if (!menu.open) {
                menu.toggle();
              }
            }}
            onDoubleClick={() =>
              useProjectFolders.getState().setEditingFolder(folder.id)
            }
            style={headerButtonStyle}
            type="button"
          >
            <span style={chevronStyle(expanded)}>
              <ChevronRight size={11} />
            </span>
            <Folder color={tokens.color.ink.muted} size={12} />
            <span style={nameStyle}>{folder.name}</span>
            {attention && !expanded ? (
              <span
                data-testid={`folder-attention-${folder.id}`}
                style={attentionDotStyle}
              />
            ) : null}
            <span style={countStyle}>{projectIds.length}</span>
          </button>
        )}
        <HeaderAction
          ariaLabel={`More actions for folder ${folder.name}`}
          onClick={() => menu.toggle()}
          title="Focus, rename or delete"
          triggerAria={menu.triggerAria}
        >
          <MoreHorizontal size={13} />
        </HeaderAction>
        {menu.open ? (
          <div role="menu" style={menuSurfaceStyle}>
            <button
              className="kr-hover-surface"
              data-testid={`focus-folder-${folder.id}`}
              onClick={() => {
                menu.close();
                useLayout
                  .getState()
                  .setFocusedFolder(focused ? null : folder.id);
              }}
              role="menuitem"
              style={menuItemStyle}
              type="button"
            >
              {focused ? "Leave focus" : "Focus on this folder"}
            </button>
            <button
              className="kr-hover-surface"
              onClick={() => {
                menu.close();
                useProjectFolders.getState().setEditingFolder(folder.id);
              }}
              role="menuitem"
              style={menuItemStyle}
              type="button"
            >
              Rename
            </button>
            <hr style={menuDividerStyle} />
            <button
              className="kr-hover-surface"
              data-testid={`delete-folder-${folder.id}`}
              onClick={() => {
                menu.close();
                deleteProjectFolder(folder.id);
              }}
              role="menuitem"
              style={{ ...menuItemStyle, color: tokens.color.status.error }}
              title="Its projects go back to the plain list"
              type="button"
            >
              Delete folder
            </button>
          </div>
        ) : null}
      </div>
      {expanded ? (
        <div style={childrenStyle}>
          {projectIds.length === 0 ? (
            <p data-testid={`folder-empty-${folder.id}`} style={emptyHintStyle}>
              {filled
                ? "Nothing open in this folder."
                : "Empty. Add a project from its ⋯ menu › Move to folder."}
            </p>
          ) : (
            children
          )}
        </div>
      ) : null}
    </section>
  );
}

const bannerStyle: CSSProperties = {
  alignItems: "center",
  background: accentAlpha(0.08),
  border: `1px solid ${accentAlpha(0.28)}`,
  borderRadius: tokens.radius.lg,
  display: "flex",
  gap: "8px",
  margin: "4px 0 6px",
  padding: "6px 6px 6px 10px",
};

const bannerTextStyle: CSSProperties = {
  display: "flex",
  flex: 1,
  flexDirection: "column",
  minWidth: 0,
};

const bannerNameStyle: CSSProperties = {
  color: tokens.color.ink.bright,
  fontSize: "12.5px",
  fontWeight: 600,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const bannerCloseStyle: CSSProperties = {
  alignItems: "center",
  background: "transparent",
  border: "none",
  borderRadius: tokens.radius.sm,
  color: tokens.color.ink.secondary,
  cursor: "pointer",
  display: "flex",
  flex: "none",
  height: "24px",
  justifyContent: "center",
  padding: 0,
  width: "24px",
};

/**
 * Names the folder the rail is narrowed to and how much it hides, with the
 * one click that ends the focus. Needs-you and Pinned stay global, so focus
 * never hides work that needs the person.
 */
export function FocusBanner({
  folder,
  hiddenCount,
}: {
  folder: ProjectFolder;
  hiddenCount: number;
}) {
  const leave = () => useLayout.getState().setFocusedFolder(null);
  return (
    <div data-testid="focus-banner" style={bannerStyle}>
      <Crosshair color={tokens.color.accentBright} size={13} />
      <div style={bannerTextStyle}>
        <span style={{ ...sectionLabel(), color: tokens.color.accentInk }}>
          Focus
          {hiddenCount > 0 ? ` · ${hiddenCount} hidden` : ""}
        </span>
        <span style={bannerNameStyle}>{folder.name}</span>
      </div>
      <button
        aria-label="Leave focus"
        className="kr-hover-surface"
        data-testid="leave-focus"
        onClick={leave}
        style={bannerCloseStyle}
        title="Leave focus (⌘⇧F)"
        type="button"
      >
        <X size={13} />
      </button>
    </div>
  );
}
