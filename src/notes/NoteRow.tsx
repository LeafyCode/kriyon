import { Check, Pin } from "lucide-react";
import type { CSSProperties } from "react";
import { relativeTime } from "../sidebar/pastSessionTime.ts";
import { useProjectNotes } from "../state/projectNotes.ts";
import { iconButton } from "../theme/recipes.ts";
import { tokens } from "../theme/tokens.ts";
import type { ProjectNote } from "../types.ts";
import { NOTE_KIND_META } from "./noteKinds.ts";

const rowStyle: CSSProperties = {
  alignItems: "flex-start",
  borderRadius: tokens.radius.md,
  display: "flex",
  gap: "8px",
  padding: "5px 6px 5px 8px",
  position: "relative",
};

const markSlotStyle: CSSProperties = {
  alignItems: "center",
  display: "flex",
  flex: "none",
  height: "18px",
  justifyContent: "center",
  width: "16px",
};

function checkboxStyle(done: boolean): CSSProperties {
  return {
    alignItems: "center",
    background: done ? tokens.color.status.done : "transparent",
    border: done ? "none" : `1.5px solid ${tokens.color.ink.dim}`,
    borderRadius: tokens.radius.sm,
    color: tokens.color.chrome.window,
    cursor: "pointer",
    display: "flex",
    height: "14px",
    justifyContent: "center",
    padding: 0,
    width: "14px",
  };
}

const bodyButtonStyle: CSSProperties = {
  background: "transparent",
  border: "none",
  color: "inherit",
  cursor: "pointer",
  display: "flex",
  flex: 1,
  flexDirection: "column",
  fontFamily: tokens.font.sans,
  gap: "1px",
  minWidth: 0,
  padding: 0,
  textAlign: "left",
};

function textStyle(done: boolean): CSSProperties {
  return {
    color: done ? tokens.color.ink.muted : tokens.color.ink.primary,
    fontSize: "12.5px",
    lineHeight: "18px",
    overflowWrap: "anywhere",
    textDecoration: done ? "line-through" : "none",
  };
}

const metaStyle: CSSProperties = {
  color: tokens.color.ink.muted,
  fontSize: "11px",
};

const pinButtonStyle: CSSProperties = {
  ...iconButton(),
  height: "22px",
  width: "22px",
};

/**
 * One [Project note] in the Notes tab. A todo leads with its checkbox; an
 * idea or a note with its kind mark. The text opens the note; pinning is a
 * hover action, and stays visible on a pinned note so the pin reads.
 */
export function NoteRow({
  note,
  now,
  onOpen,
}: {
  note: ProjectNote;
  now: number;
  onOpen: (id: string) => void;
}) {
  const toggleDone = useProjectNotes((state) => state.toggleDone);
  const update = useProjectNotes((state) => state.update);
  const meta = NOTE_KIND_META[note.kind];
  const done = note.doneAt !== null;
  const Icon = meta.icon;
  const when = relativeTime(note.doneAt ?? note.createdMs, now);
  const metaLine = `${done ? `Done ${when}` : when}${note.body ? " · has more" : ""}`;

  return (
    <div
      className="kr-row kr-reveal-parent"
      data-testid="note-row"
      style={rowStyle}
    >
      <span style={markSlotStyle}>
        {note.kind === "todo" ? (
          <button
            aria-label={
              done ? `Mark "${note.text}" not done` : `Mark "${note.text}" done`
            }
            aria-pressed={done}
            onClick={() => toggleDone(note.id, Date.now())}
            style={checkboxStyle(done)}
            type="button"
          >
            {done ? (
              <Check aria-hidden="true" size={10} strokeWidth={3.5} />
            ) : null}
          </button>
        ) : (
          <Icon
            aria-label={meta.label}
            color={meta.color}
            role="img"
            size={14}
            strokeWidth={1.75}
          />
        )}
      </span>
      <button
        onClick={() => onOpen(note.id)}
        style={bodyButtonStyle}
        type="button"
      >
        <span style={textStyle(done)}>{note.text}</span>
        <span style={metaStyle}>{metaLine}</span>
      </button>
      {done ? null : (
        <button
          aria-label={
            note.pinned
              ? `Unpin "${note.text}"`
              : `Pin "${note.text}" to the top`
          }
          aria-pressed={note.pinned}
          className={
            note.pinned ? "kr-hover-surface" : "kr-hover-surface kr-reveal"
          }
          onClick={() => update(note.id, { pinned: !note.pinned }, Date.now())}
          style={{
            ...pinButtonStyle,
            color: note.pinned
              ? tokens.color.accentBright
              : tokens.color.ink.muted,
          }}
          title={note.pinned ? "Unpin" : "Pin to top"}
          type="button"
        >
          <Pin fill={note.pinned ? "currentColor" : "none"} size={12} />
        </button>
      )}
    </div>
  );
}
