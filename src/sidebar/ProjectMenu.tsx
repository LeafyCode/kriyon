/**
 * A project header's "⋯" popover (also opened by right-clicking the header):
 * park (put the project away and stop what it runs), its notes, rename, colour, sort, and
 * the destructive clear that closes every session in the group. Colour and
 * sort open their own popovers in this one's place; they live here, not in
 * the hover row, so that row stays short enough to leave the name readable. Its own component (the session row's
 * `⋯` menu is the sibling pattern) so the header stays about chrome.
 *
 * The clear only *asks* here — the confirm itself is the group's centered
 * {@link ConfirmDialog}, not a second popover step. A block of confirm copy
 * hanging off this trigger landed in the middle of a 278px rail, on top of the
 * other projects.
 */
import { Check, ChevronRight } from "lucide-react";
import { type CSSProperties, useState } from "react";
import type { ProjectFolder } from "../state/projectFolders.ts";
import { tokens } from "../theme/tokens.ts";
import { anchoredMenuSurfaceStyle } from "../ui/AnchoredMenu.tsx";

/** A fixed width, not a `minWidth`: a surface sized to its own content drifts
 *  wider than the other header popovers for no reason. Shared with the folder
 *  header's menu, so the two header popovers stay alike. */
export const headerMenuSurfaceStyle: CSSProperties = {
  ...anchoredMenuSurfaceStyle,
  padding: "4px",
  width: "186px",
};

export const headerMenuItemStyle: CSSProperties = {
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

const destructiveItemStyle: CSSProperties = {
  ...headerMenuItemStyle,
  color: tokens.color.status.error,
};

const folderItemStyle: CSSProperties = {
  ...headerMenuItemStyle,
  alignItems: "center",
  gap: "6px",
};

/** The tick column, so ticked and unticked folder names line up. */
const tickSlotStyle: CSSProperties = {
  alignItems: "center",
  color: tokens.color.accentBright,
  display: "flex",
  flex: "none",
  width: "12px",
};

const folderNameStyle: CSSProperties = {
  flex: 1,
  minWidth: 0,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

export const headerMenuDividerStyle: CSSProperties = {
  border: "none",
  borderTop: `1px solid ${tokens.color.line.soft}`,
  margin: "4px 0",
};

interface ProjectMenuProps {
  /** The [Project folder] the project is in, or null. */
  folderId: string | null;
  /** Every folder, for the Move to folder list. */
  folders: ProjectFolder[];
  /** Open the colour picker in this menu's place. */
  onColour: () => void;
  /** Put the project in a folder, or back in the plain list (null). */
  onMoveToFolder: (folderId: string | null) => void;
  /** Make a folder holding this project and open its name for editing. */
  onNewFolder: () => void;
  /** Show the project's [Project note]s in the inspector. */
  onOpenNotes: () => void;
  onRename: () => void;
  /** Ask to close every session in the project — opens the group's confirm. */
  onRequestClear: () => void;
  /** Ask to park the project — parks at once, or opens the group's confirm
   *  when work is in flight. */
  onRequestPark: () => void;
  /** Open the project's sort menu in this menu's place. */
  onSort: () => void;
  /** Pin the project to the top of the sidebar, or unpin it. */
  onTogglePin: () => void;
  pinned: boolean;
  projectId: string;
}

interface Item {
  label: string;
  onClick: () => void;
  testId?: string;
  title?: string;
}

export function ProjectMenu({
  folderId,
  folders,
  onMoveToFolder,
  onNewFolder,
  onTogglePin,
  pinned,
  onColour,
  onOpenNotes,
  onRename,
  onRequestClear,
  onRequestPark,
  onSort,
  projectId,
}: ProjectMenuProps) {
  const [showFolders, setShowFolders] = useState(false);
  if (showFolders) {
    return (
      <FolderList
        folderId={folderId}
        folders={folders}
        onMoveToFolder={onMoveToFolder}
        onNewFolder={onNewFolder}
        projectId={projectId}
      />
    );
  }
  // Pin and folder lead: they are how the rail is organised. Park follows —
  // the action people come here for most among the rest.
  const items: Item[] = [
    {
      label: pinned ? "Unpin" : "Pin to top",
      onClick: onTogglePin,
      testId: `pin-project-${projectId}`,
    },
    {
      label: "Park project",
      onClick: onRequestPark,
      testId: `park-project-${projectId}`,
      title: "Stop its sessions and terminals and move it to Parked",
    },
    {
      label: "Open notes",
      onClick: onOpenNotes,
      title: "Your todos, ideas and notes for this project",
    },
    {
      label: "Rename",
      onClick: onRename,
      testId: `rename-project-menu-${projectId}`,
    },
    { label: "Colour…", onClick: onColour },
    { label: "Sort sessions…", onClick: onSort },
  ];
  return (
    <div role="menu" style={headerMenuSurfaceStyle}>
      {items.slice(0, 1).map((item) => (
        <button
          className="kr-hover-surface"
          data-testid={item.testId}
          key={item.label}
          onClick={item.onClick}
          role="menuitem"
          style={headerMenuItemStyle}
          type="button"
        >
          {item.label}
        </button>
      ))}
      {/* Pinned projects live outside folders (Pinned draws them), so the
        move is offered only once the project is unpinned. */}
      {pinned ? null : (
        <button
          aria-haspopup="menu"
          className="kr-hover-surface"
          data-testid={`move-to-folder-${projectId}`}
          onClick={() => setShowFolders(true)}
          role="menuitem"
          style={folderItemStyle}
          type="button"
        >
          <span style={folderNameStyle}>Move to folder</span>
          <ChevronRight color={tokens.color.ink.dim} size={12} />
        </button>
      )}
      <hr style={headerMenuDividerStyle} />
      {items.slice(1).map((item) => (
        <button
          className="kr-hover-surface"
          data-testid={item.testId}
          key={item.label}
          onClick={item.onClick}
          role="menuitem"
          style={headerMenuItemStyle}
          title={item.title}
          type="button"
        >
          {item.label}
        </button>
      ))}
      <hr style={headerMenuDividerStyle} />
      <button
        className="kr-hover-surface"
        data-testid={`clear-project-${projectId}`}
        onClick={onRequestClear}
        role="menuitem"
        style={destructiveItemStyle}
        type="button"
      >
        Close all sessions
      </button>
    </div>
  );
}

/**
 * The Move to folder step, shown in the menu's place: every folder with a tick
 * on the current one (a project is in at most one), then New folder… and, when
 * it is in one, Take out of folder.
 */
function FolderList({
  folderId,
  folders,
  onMoveToFolder,
  onNewFolder,
  projectId,
}: {
  folderId: string | null;
  folders: ProjectFolder[];
  onMoveToFolder: (folderId: string | null) => void;
  onNewFolder: () => void;
  projectId: string;
}) {
  const sorted = [...folders].sort((a, b) => a.name.localeCompare(b.name));
  return (
    <div
      aria-label="Move to folder"
      data-testid={`folder-list-${projectId}`}
      role="menu"
      style={headerMenuSurfaceStyle}
    >
      {sorted.map((folder) => (
        <button
          aria-checked={folder.id === folderId}
          className="kr-hover-surface"
          key={folder.id}
          onClick={() => onMoveToFolder(folder.id)}
          role="menuitemradio"
          style={folderItemStyle}
          type="button"
        >
          <span style={tickSlotStyle}>
            {folder.id === folderId ? <Check size={12} /> : null}
          </span>
          <span style={folderNameStyle}>{folder.name}</span>
        </button>
      ))}
      {sorted.length > 0 ? <hr style={headerMenuDividerStyle} /> : null}
      <button
        className="kr-hover-surface"
        data-testid={`new-folder-for-${projectId}`}
        onClick={onNewFolder}
        role="menuitem"
        style={folderItemStyle}
        type="button"
      >
        <span style={tickSlotStyle} />
        New folder…
      </button>
      {folderId === null ? null : (
        <button
          className="kr-hover-surface"
          data-testid={`take-out-of-folder-${projectId}`}
          onClick={() => onMoveToFolder(null)}
          role="menuitem"
          style={folderItemStyle}
          type="button"
        >
          <span style={tickSlotStyle} />
          Take out of folder
        </button>
      )}
    </div>
  );
}
