import type { CSSProperties } from "react";
import { iconButton } from "../theme/recipes.ts";
import { tokens } from "../theme/tokens.ts";

export interface PromptRowActionsProps {
  deleteArmed: boolean;
  favourite: boolean;
  insertDisabled: boolean;
  onDelete: () => void;
  onEdit: () => void;
  onInsert: () => void;
  onToggleFavourite: () => void;
}

const clusterStyle: CSSProperties = {
  alignItems: "center",
  display: "flex",
  flex: "none",
  gap: "2px",
};

/** The shared 26×26 icon button, tinted for the armed/favourited states.
 *  `accent` is a fill colour, so the lit star takes `accentBright`. */
function iconButtonStyle(opts: {
  active?: boolean;
  danger?: boolean;
  disabled?: boolean;
}): CSSProperties {
  let color: string = tokens.color.ink.muted;
  if (opts.danger) {
    color = tokens.color.status.error;
  } else if (opts.active) {
    color = tokens.color.accentBright;
  }
  return {
    ...iconButton(),
    color,
    cursor: opts.disabled ? "default" : "pointer",
    fontFamily: tokens.font.sans,
    fontSize: "13px",
    lineHeight: 1,
    opacity: opts.disabled ? 0.4 : 1,
  };
}

/**
 * [Prompt row actions]: the shared visible controls on each [Saved prompt] row
 * in both the [Prompt library view] and the [Prompt picker]. Presentational —
 * every action is a callback and the parent owns the store and the two-click
 * delete arming, so this stays testable in isolation.
 */
export function PromptRowActions({
  deleteArmed,
  favourite,
  insertDisabled,
  onDelete,
  onEdit,
  onInsert,
  onToggleFavourite,
}: PromptRowActionsProps) {
  return (
    <div style={clusterStyle}>
      <button
        aria-label="Insert prompt"
        className="kr-hover-surface"
        disabled={insertDisabled}
        onClick={onInsert}
        style={iconButtonStyle({ disabled: insertDisabled })}
        title={insertDisabled ? "Open a session to insert" : "Insert"}
        type="button"
      >
        ⤵
      </button>
      <button
        aria-label={favourite ? "Unfavourite" : "Favourite"}
        className="kr-hover-surface"
        onClick={onToggleFavourite}
        style={iconButtonStyle({ active: favourite })}
        type="button"
      >
        {favourite ? "★" : "☆"}
      </button>
      <button
        aria-label="Edit prompt"
        className="kr-hover-surface"
        onClick={onEdit}
        style={iconButtonStyle({})}
        title="Edit"
        type="button"
      >
        ✎
      </button>
      <button
        aria-label={deleteArmed ? "Confirm delete" : "Delete prompt"}
        className="kr-hover-surface"
        onClick={onDelete}
        style={iconButtonStyle({ danger: deleteArmed })}
        title={deleteArmed ? "Click again to delete" : "Delete"}
        type="button"
      >
        {deleteArmed ? "⌫?" : "⌫"}
      </button>
    </div>
  );
}
