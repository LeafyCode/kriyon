import { ChevronRight, NotebookPen } from "lucide-react";
import { type CSSProperties, useMemo, useState } from "react";
import {
  type NotesFilter,
  notesView,
  useProjectNotes,
} from "../state/projectNotes.ts";
import { useSessions } from "../state/sessions.ts";
import { projectColor } from "../theme/projectColor.ts";
import { tokens } from "../theme/tokens.ts";
import type { ProjectRow } from "../types.ts";
import { Kbd } from "../ui/Kbd.tsx";
import { NoteCapture } from "./NoteCapture.tsx";
import { NoteDetail } from "./NoteDetail.tsx";
import { NoteRow } from "./NoteRow.tsx";
import { NOTE_KIND_META, NOTE_KINDS } from "./noteKinds.ts";

const rootStyle: CSSProperties = {
  display: "flex",
  flex: 1,
  flexDirection: "column",
  minHeight: 0,
};

const headStyle: CSSProperties = {
  alignItems: "baseline",
  display: "flex",
  gap: "8px",
  padding: "12px 14px 8px",
};

function projectSquareStyle(project: ProjectRow): CSSProperties {
  return {
    alignSelf: "center",
    background: projectColor(project),
    borderRadius: "2px",
    flex: "none",
    height: "8px",
    width: "8px",
  };
}

const projectNameStyle: CSSProperties = {
  color: tokens.color.ink.bright,
  fontSize: "12.5px",
  fontWeight: 500,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const captionStyle: CSSProperties = {
  color: tokens.color.ink.muted,
  flex: "none",
  fontSize: "11px",
};

const filtersStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: "4px",
  padding: "10px 14px 6px",
};

function filterStyle(active: boolean): CSSProperties {
  return {
    alignItems: "center",
    background: active ? tokens.color.surface.active : "transparent",
    border: "none",
    borderRadius: tokens.radius.pill,
    color: active ? tokens.color.ink.bright : tokens.color.ink.muted,
    cursor: "pointer",
    display: "inline-flex",
    fontFamily: tokens.font.sans,
    fontSize: "11.5px",
    gap: "6px",
    height: "24px",
    padding: "0 9px",
  };
}

const countStyle: CSSProperties = {
  fontFamily: tokens.font.mono,
  fontSize: "10.5px",
};

const listStyle: CSSProperties = {
  display: "flex",
  flex: 1,
  flexDirection: "column",
  gap: "1px",
  minHeight: 0,
  overflowY: "auto",
  padding: "0 6px 16px",
};

const doneToggleStyle: CSSProperties = {
  alignItems: "center",
  alignSelf: "flex-start",
  background: "transparent",
  border: "none",
  borderRadius: tokens.radius.sm,
  color: tokens.color.ink.muted,
  cursor: "pointer",
  display: "flex",
  fontFamily: tokens.font.sans,
  fontSize: "11.5px",
  gap: "6px",
  height: "24px",
  margin: "10px 0 2px 2px",
  padding: "0 6px",
};

function chevronStyle(open: boolean): CSSProperties {
  return {
    display: "flex",
    transform: open ? "rotate(90deg)" : "none",
    transition: `transform ${tokens.motion.disclose}`,
  };
}

const emptyStyle: CSSProperties = {
  alignItems: "center",
  color: tokens.color.ink.muted,
  display: "flex",
  flexDirection: "column",
  fontSize: "12px",
  gap: "8px",
  lineHeight: 1.5,
  padding: "40px 24px",
  textAlign: "center",
};

const emptyTitleStyle: CSSProperties = {
  color: tokens.color.ink.primary,
  fontSize: "13px",
  fontWeight: 500,
};

const FILTERS: readonly NotesFilter[] = ["all", ...NOTE_KINDS];

function filterLabel(filter: NotesFilter): string {
  return filter === "all" ? "All" : NOTE_KIND_META[filter].plural;
}

/**
 * The Details rail's Notes tab: the [Project note]s of one project — the
 * capture box, a kind filter, open notes, and done todos folded away. Opening
 * a note swaps the list for its {@link NoteDetail}.
 */
export function NotesTab({ projectId }: { projectId: string }) {
  const project = useSessions((state) =>
    state.projects.find((p) => p.id === projectId)
  );
  const notes = useProjectNotes((state) => state.notes);
  const [filter, setFilter] = useState<NotesFilter>("all");
  const [showDone, setShowDone] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const view = useMemo(
    () => notesView(notes, projectId, filter),
    [notes, projectId, filter]
  );

  const opened = openId
    ? notes.find((n) => n.id === openId && n.projectId === projectId)
    : undefined;
  if (opened) {
    return (
      <div style={rootStyle}>
        <NoteDetail
          key={opened.id}
          note={opened}
          onBack={() => setOpenId(null)}
        />
      </div>
    );
  }

  const now = Date.now();
  const isEmpty =
    view.counts.all === 0 && view.done.length === 0 && filter === "all";

  return (
    <div data-testid="notes-tab" style={rootStyle}>
      {project ? (
        <div style={headStyle}>
          <span style={projectSquareStyle(project)} />
          <span style={projectNameStyle}>{project.name}</span>
          <span style={captionStyle}>· every session sees these</span>
        </div>
      ) : null}
      <div style={{ padding: "0 14px" }}>
        <NoteCapture projectId={projectId} />
      </div>

      {isEmpty ? (
        <div style={emptyStyle}>
          <NotebookPen
            aria-hidden="true"
            color={tokens.color.ink.dim}
            size={28}
            strokeWidth={1.25}
          />
          <span style={emptyTitleStyle}>Nothing planned here yet</span>
          <span>
            Keep todos, ideas and notes for this project. They stay with the
            project, not a session, and are never sent to Claude.
          </span>
          <span>
            <Kbd>⌘⇧N</Kbd> adds one from anywhere
          </span>
        </div>
      ) : (
        <>
          <fieldset
            aria-label="Show"
            style={{ ...filtersStyle, border: 0, margin: 0 }}
          >
            {FILTERS.map((option) => (
              <button
                aria-pressed={filter === option}
                className={filter === option ? undefined : "kr-hover-surface"}
                key={option}
                onClick={() => setFilter(option)}
                style={filterStyle(filter === option)}
                type="button"
              >
                {filterLabel(option)}
                <span style={countStyle}>{view.counts[option]}</span>
              </button>
            ))}
          </fieldset>
          <div style={listStyle}>
            {view.open.map((note) => (
              <NoteRow key={note.id} note={note} now={now} onOpen={setOpenId} />
            ))}
            {view.done.length > 0 ? (
              <>
                <button
                  aria-expanded={showDone}
                  className="kr-hover-surface"
                  onClick={() => setShowDone((open) => !open)}
                  style={doneToggleStyle}
                  type="button"
                >
                  <span style={chevronStyle(showDone)}>
                    <ChevronRight size={10} strokeWidth={2.5} />
                  </span>
                  Done
                  <span style={countStyle}>{view.done.length}</span>
                </button>
                {showDone
                  ? view.done.map((note) => (
                      <NoteRow
                        key={note.id}
                        note={note}
                        now={now}
                        onOpen={setOpenId}
                      />
                    ))
                  : null}
              </>
            ) : null}
          </div>
        </>
      )}
    </div>
  );
}
