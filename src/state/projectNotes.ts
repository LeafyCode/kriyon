import { create } from "zustand";
import { deleteProjectNote, upsertProjectNote } from "../ipc/bridge.ts";
import { failureMessage } from "../ipc/failures.ts";
import type { NoteKind, ProjectNote } from "../types.ts";
import { showToast } from "../ui/Toast.tsx";
import { useLayout } from "./layout.ts";
import { useSessions } from "./sessions.ts";

/** The longest a note's text may be (mirrors Rust `MAX_TEXT_CHARS`). */
export const NOTE_TEXT_MAX = 500;

/** Which notes the Notes tab lists: every kind, or one. */
export type NotesFilter = "all" | NoteKind;

/** Open notes by kind, plus their total. */
export type NotesCounts = Record<NotesFilter, number>;

export interface NotesView {
  counts: NotesCounts;
  /** Done todos, most recently done first. */
  done: ProjectNote[];
  /** Open notes, pinned first, then newest first. */
  open: ProjectNote[];
}

/** The fields an edit may change. */
export type NotePatch = Partial<
  Pick<ProjectNote, "body" | "kind" | "pinned" | "text">
>;

interface ProjectNotesState {
  /** Add a note; returns it, or null for blank text. */
  add: (
    projectId: string,
    kind: NoteKind,
    text: string,
    nowMs: number
  ) => ProjectNote | null;
  /** Every [Project note] of every project, hydrated at boot. */
  notes: ProjectNote[];
  /**
   * A project the user chose to see in the Notes tab (the project menu's
   * "Open notes"), shown instead of the active session's. Cleared when another
   * session becomes active — see {@link installNotesPickReset}.
   */
  pickedProjectId: string | null;
  remove: (id: string) => void;
  setNotes: (notes: ProjectNote[]) => void;
  setPickedProjectId: (projectId: string | null) => void;
  /** Tick a todo off, or back on. Does nothing for an idea or a note. */
  toggleDone: (id: string, nowMs: number) => void;
  update: (id: string, patch: NotePatch, nowMs: number) => void;
}

function isDone(note: ProjectNote): boolean {
  return note.doneAt !== null;
}

/**
 * The [Project note]s store. Every change shows at once and is then saved
 * through the bridge. A save that lands swaps in the backend's stored copy; a
 * save that fails puts back the last copy known to be stored and says so — a
 * note the user believes is kept must never vanish quietly on the next launch.
 *
 * Saves can overlap (an edit, then a pin before the edit lands). Each one only
 * touches the note while it still shows that save's own copy, so a save that
 * settles late never undoes a later change or brings back a deleted note.
 */
export const useProjectNotes = create<ProjectNotesState>((set, get) => {
  /** The last copy of each note known to be in the database. */
  const stored = new Map<string, ProjectNote>();

  /** Replace `id` with `next` (or drop it when `next` is null). */
  const put = (id: string, next: ProjectNote | null) =>
    set((state) => {
      const rest = state.notes.filter((n) => n.id !== id);
      return { notes: next ? [...rest, next] : rest };
    });

  /** Whether the note still shows `copy`, untouched by any later change. */
  const stillShows = (copy: ProjectNote) => get().notes.some((n) => n === copy);

  const save = (next: ProjectNote) => {
    put(next.id, next);
    upsertProjectNote(next).then(
      (row) => {
        stored.set(row.id, row);
        if (stillShows(next)) {
          put(row.id, row);
        }
      },
      (error: unknown) => {
        if (stillShows(next)) {
          put(next.id, stored.get(next.id) ?? null);
        }
        showToast(`Note not saved: ${failureMessage(error)}`, "error");
      }
    );
  };

  const find = (id: string) => get().notes.find((n) => n.id === id) ?? null;

  return {
    notes: [],
    pickedProjectId: null,
    setNotes: (notes) => {
      stored.clear();
      for (const note of notes) {
        stored.set(note.id, note);
      }
      set({ notes });
    },
    setPickedProjectId: (pickedProjectId) => set({ pickedProjectId }),
    add: (projectId, kind, text, nowMs) => {
      const trimmed = text.trim();
      if (!trimmed) {
        return null;
      }
      const note: ProjectNote = {
        body: "",
        createdMs: nowMs,
        doneAt: null,
        id: crypto.randomUUID(),
        kind,
        pinned: false,
        projectId,
        text: trimmed,
        updatedMs: nowMs,
      };
      save(note);
      return note;
    },
    update: (id, patch, nowMs) => {
      const existing = find(id);
      if (!existing) {
        return;
      }
      // A blank text keeps the old one: a note always has text, and the
      // rest of the edit (a body typed under a cleared title) still saves.
      const text = patch.text?.trim() || existing.text;
      const kind = patch.kind ?? existing.kind;
      save({
        ...existing,
        ...patch,
        doneAt: kind === "todo" ? existing.doneAt : null,
        kind,
        text,
        updatedMs: nowMs,
      });
    },
    toggleDone: (id, nowMs) => {
      const existing = find(id);
      if (existing?.kind !== "todo") {
        return;
      }
      save({
        ...existing,
        doneAt: isDone(existing) ? null : nowMs,
        updatedMs: nowMs,
      });
    },
    remove: (id) => {
      const existing = find(id);
      if (!existing) {
        return;
      }
      put(id, null);
      deleteProjectNote(id).then(
        () => {
          stored.delete(id);
        },
        (error: unknown) => {
          put(id, stored.get(id) ?? existing);
          showToast(`Note not deleted: ${failureMessage(error)}`, "error");
        }
      );
    },
  };
});

function byPinnedThenNewest(a: ProjectNote, b: ProjectNote): number {
  return Number(b.pinned) - Number(a.pinned) || b.createdMs - a.createdMs;
}

/** What the Notes tab shows for one project under one filter. */
export function notesView(
  notes: readonly ProjectNote[],
  projectId: string,
  filter: NotesFilter
): NotesView {
  const mine = notes.filter((n) => n.projectId === projectId);
  const open = mine.filter((n) => !isDone(n));
  const counts: NotesCounts = {
    all: open.length,
    idea: open.filter((n) => n.kind === "idea").length,
    note: open.filter((n) => n.kind === "note").length,
    todo: open.filter((n) => n.kind === "todo").length,
  };
  const shown = (n: ProjectNote) => filter === "all" || n.kind === filter;
  return {
    counts,
    done: mine
      .filter((n) => isDone(n) && shown(n))
      .sort((a, b) => (b.doneAt ?? 0) - (a.doneAt ?? 0)),
    open: open.filter(shown).sort(byPinnedThenNewest),
  };
}

/** A project's open todos — the one number the sidebar shows for notes. */
export function openTodoCount(
  notes: readonly ProjectNote[],
  projectId: string
): number {
  return notes.filter(
    (n) => n.projectId === projectId && n.kind === "todo" && !isDone(n)
  ).length;
}

/** The project the Notes tab shows: a picked one, else the active
 *  session's. */
export function notesProjectId(
  pickedProjectId: string | null,
  activeProjectId: string | null
): string | null {
  return pickedProjectId ?? activeProjectId;
}

/** The project the Notes tab shows right now, or null with nothing to show. */
export function useNotesProjectId(): string | null {
  const pickedProjectId = useProjectNotes((state) => state.pickedProjectId);
  const activeProjectId = useSessions((state) =>
    state.activeSessionId
      ? (state.sessions[state.activeSessionId]?.projectId ?? null)
      : null
  );
  return notesProjectId(pickedProjectId, activeProjectId);
}

/**
 * Show a project's notes: the Notes tab of an open inspector, in the session
 * view, picked for this project until another session is opened. The project
 * menu's "Open notes" — it never opens a session, so a parked project's notes
 * can be read without bringing the project back.
 */
export function openProjectNotes(projectId: string): void {
  useProjectNotes.getState().setPickedProjectId(projectId);
  const layout = useLayout.getState();
  layout.setInspectorTab("notes");
  if (layout.layout.view !== "studio") {
    layout.setView("studio");
  }
  if (layout.layout.inspectorCollapsed) {
    layout.toggleInspectorCollapsed();
  }
}

/**
 * Drop the Notes tab's picked project whenever another session becomes
 * active, so opening a session always shows that session's notes. Returns the
 * unsubscribe.
 */
export function installNotesPickReset(): () => void {
  return useSessions.subscribe((state, prev) => {
    if (
      state.activeSessionId !== prev.activeSessionId &&
      useProjectNotes.getState().pickedProjectId !== null
    ) {
      useProjectNotes.getState().setPickedProjectId(null);
    }
  });
}
