import { beforeEach, describe, expect, it, vi } from "vitest";
import rustNotes from "../../crates/kriyon-core/src/project_notes.rs?raw";
import { deleteProjectNote, upsertProjectNote } from "../ipc/bridge.ts";
import type { ProjectNote } from "../types.ts";
import { showToast } from "../ui/Toast.tsx";
import { DEFAULT_LAYOUT, useLayout } from "./layout.ts";
import {
  installNotesPickReset,
  NOTE_BODY_MAX,
  NOTE_TEXT_MAX,
  notesProjectId,
  notesView,
  openProjectNotes,
  openTodoCount,
  useProjectNotes,
} from "./projectNotes.ts";
import { useSessions } from "./sessions.ts";

vi.mock("../ipc/bridge.ts", () => ({
  deleteProjectNote: vi.fn(() => Promise.resolve()),
  upsertProjectNote: vi.fn((note: ProjectNote) => Promise.resolve(note)),
}));

vi.mock("../ui/Toast.tsx", () => ({ showToast: vi.fn() }));

const mockedUpsert = vi.mocked(upsertProjectNote);
const mockedDelete = vi.mocked(deleteProjectNote);

function note(over: Partial<ProjectNote>): ProjectNote {
  return {
    body: "",
    createdMs: 1,
    doneAt: null,
    id: "n1",
    kind: "todo",
    pinned: false,
    projectId: "p1",
    text: "text",
    updatedMs: 1,
    ...over,
  };
}

/** Let the store's settled IPC promise run its follow-up. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** A `pub const NAME: usize = N;` from the Rust notes module. */
function rustLimit(name: string): number {
  const match = rustNotes.match(
    new RegExp(`pub const ${name}: usize = ([\\d_]+);`)
  );
  return Number(match?.[1].split("_").join(""));
}

describe("note limits", () => {
  // The inputs cap what the backend accepts; if they drift, a typed note is
  // refused on save and rolled back.
  it("match the Rust limits", () => {
    expect(NOTE_TEXT_MAX).toBe(rustLimit("MAX_TEXT_CHARS"));
    expect(NOTE_BODY_MAX).toBe(rustLimit("MAX_BODY_CHARS"));
  });
});

describe("notesView", () => {
  const notes = [
    note({ createdMs: 1, id: "old-todo" }),
    note({ createdMs: 5, id: "new-idea", kind: "idea" }),
    note({ createdMs: 2, id: "pinned-note", kind: "note", pinned: true }),
    note({ createdMs: 3, doneAt: 10, id: "done-early" }),
    note({ createdMs: 4, doneAt: 20, id: "done-late" }),
    note({ createdMs: 9, id: "other-project", projectId: "p2" }),
  ];

  it("lists one project's open notes pinned first, then newest first", () => {
    const view = notesView(notes, "p1", "all");
    expect(view.open.map((n) => n.id)).toEqual([
      "pinned-note",
      "new-idea",
      "old-todo",
    ]);
  });

  it("lists done todos apart, most recently done first", () => {
    const view = notesView(notes, "p1", "all");
    expect(view.done.map((n) => n.id)).toEqual(["done-late", "done-early"]);
  });

  it("counts open notes by kind, whatever the filter", () => {
    const view = notesView(notes, "p1", "idea");
    expect(view.counts).toEqual({ all: 3, idea: 1, note: 1, todo: 1 });
  });

  it("filters both lists by kind", () => {
    expect(notesView(notes, "p1", "idea").open.map((n) => n.id)).toEqual([
      "new-idea",
    ]);
    expect(notesView(notes, "p1", "idea").done).toEqual([]);
    expect(notesView(notes, "p1", "todo").done).toHaveLength(2);
  });
});

describe("openTodoCount", () => {
  it("counts only a project's open todos", () => {
    const notes = [
      note({ id: "a" }),
      note({ doneAt: 3, id: "b" }),
      note({ id: "c", kind: "idea" }),
      note({ id: "d", projectId: "p2" }),
    ];
    expect(openTodoCount(notes, "p1")).toBe(1);
  });
});

describe("notesProjectId", () => {
  it("follows the active session's project by default", () => {
    expect(notesProjectId(null, "p1")).toBe("p1");
  });

  it("shows a picked project instead", () => {
    expect(notesProjectId("p2", "p1")).toBe("p2");
  });

  it("shows a project picked with no session open", () => {
    expect(notesProjectId("p2", null)).toBe("p2");
  });
});

describe("installNotesPickReset", () => {
  it("drops the pick once another session becomes active, for good", () => {
    useSessions.setState({ activeSessionId: "s1" });
    const stop = installNotesPickReset();
    openProjectNotes("p2");
    expect(useProjectNotes.getState().pickedProjectId).toBe("p2");

    useSessions.setState({ activeSessionId: "s2" });
    expect(useProjectNotes.getState().pickedProjectId).toBeNull();
    useSessions.setState({ activeSessionId: "s1" });
    expect(useProjectNotes.getState().pickedProjectId).toBeNull();
    stop();
  });

  it("keeps the pick while the same session stays active", () => {
    useSessions.setState({ activeSessionId: "s1" });
    const stop = installNotesPickReset();
    openProjectNotes("p2");
    useSessions.setState({ projects: [] });
    expect(useProjectNotes.getState().pickedProjectId).toBe("p2");
    stop();
  });
});

describe("useProjectNotes", () => {
  beforeEach(() => {
    useProjectNotes.setState({ notes: [], pickedProjectId: null });
    vi.clearAllMocks();
  });

  it("add trims, saves and returns the new note", () => {
    const added = useProjectNotes.getState().add("p1", "idea", "  Split  ", 7);
    expect(added).toMatchObject({
      createdMs: 7,
      kind: "idea",
      projectId: "p1",
      text: "Split",
    });
    expect(useProjectNotes.getState().notes).toEqual([added]);
    expect(mockedUpsert).toHaveBeenCalledWith(added);
  });

  it("add ignores blank text", () => {
    expect(useProjectNotes.getState().add("p1", "todo", "   ", 7)).toBeNull();
    expect(useProjectNotes.getState().notes).toEqual([]);
    expect(mockedUpsert).not.toHaveBeenCalled();
  });

  it("toggleDone ticks a todo off and back on", () => {
    useProjectNotes.setState({ notes: [note({})] });
    useProjectNotes.getState().toggleDone("n1", 50);
    expect(useProjectNotes.getState().notes[0]).toMatchObject({
      doneAt: 50,
      updatedMs: 50,
    });
    useProjectNotes.getState().toggleDone("n1", 60);
    expect(useProjectNotes.getState().notes[0].doneAt).toBeNull();
  });

  it("toggleDone leaves an idea alone", () => {
    useProjectNotes.setState({ notes: [note({ kind: "idea" })] });
    useProjectNotes.getState().toggleDone("n1", 50);
    expect(useProjectNotes.getState().notes[0].doneAt).toBeNull();
    expect(mockedUpsert).not.toHaveBeenCalled();
  });

  it("update clears the done mark when a todo becomes an idea", () => {
    useProjectNotes.setState({ notes: [note({ doneAt: 5 })] });
    useProjectNotes.getState().update("n1", { kind: "idea" }, 9);
    expect(useProjectNotes.getState().notes[0]).toMatchObject({
      doneAt: null,
      kind: "idea",
      updatedMs: 9,
    });
  });

  it("update keeps the old text when the new one is blank, and still saves the rest", () => {
    useProjectNotes.getState().setNotes([note({})]);
    useProjectNotes
      .getState()
      .update("n1", { body: "kept detail", text: "  " }, 9);
    expect(useProjectNotes.getState().notes[0]).toMatchObject({
      body: "kept detail",
      text: "text",
    });
    expect(mockedUpsert).toHaveBeenCalledTimes(1);
  });

  it("takes the backend's stored copy once a save lands", async () => {
    mockedUpsert.mockImplementationOnce((sent) =>
      Promise.resolve({ ...sent, text: "stored" })
    );
    useProjectNotes.getState().add("p1", "todo", "sent", 1);
    await flush();
    expect(useProjectNotes.getState().notes[0].text).toBe("stored");
  });

  it("rolls back and says so when a save fails", async () => {
    useProjectNotes.getState().setNotes([note({})]);
    mockedUpsert.mockImplementationOnce(() => Promise.reject("disk full"));
    useProjectNotes.getState().update("n1", { text: "edited" }, 9);
    expect(useProjectNotes.getState().notes[0].text).toBe("edited");
    await flush();
    expect(useProjectNotes.getState().notes[0].text).toBe("text");
    expect(showToast).toHaveBeenCalledWith(expect.any(String), "error");
  });

  it("drops a new note whose first save fails", async () => {
    mockedUpsert.mockImplementationOnce(() => Promise.reject("disk full"));
    useProjectNotes.getState().add("p1", "todo", "lost", 1);
    await flush();
    expect(useProjectNotes.getState().notes).toEqual([]);
  });

  it("remove deletes, and puts the note back if the delete fails", async () => {
    useProjectNotes.getState().setNotes([note({})]);
    mockedDelete.mockImplementationOnce(() => Promise.reject("locked"));
    useProjectNotes.getState().remove("n1");
    expect(useProjectNotes.getState().notes).toEqual([]);
    expect(mockedDelete).toHaveBeenCalledWith("n1");
    await flush();
    expect(useProjectNotes.getState().notes).toEqual([note({})]);
    expect(showToast).toHaveBeenCalledWith(expect.any(String), "error");
  });
});

describe("useProjectNotes, overlapping saves", () => {
  /** An upsert the test settles by hand, to order overlapping saves. */
  function heldUpsert() {
    let settle: { reject: (e: unknown) => void; resolve: () => void } = {
      reject: () => undefined,
      resolve: () => undefined,
    };
    mockedUpsert.mockImplementationOnce(
      (sent) =>
        new Promise((resolve, reject) => {
          settle = { reject, resolve: () => resolve(sent) };
        })
    );
    return () => settle;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    useProjectNotes.setState({ pickedProjectId: null });
    useProjectNotes.getState().setNotes([note({})]);
  });

  it("a slow first save does not undo a later edit", async () => {
    const first = heldUpsert();
    useProjectNotes.getState().update("n1", { text: "first" }, 2);
    useProjectNotes.getState().update("n1", { text: "second" }, 3);
    await flush();
    first().resolve();
    await flush();
    expect(useProjectNotes.getState().notes[0].text).toBe("second");
  });

  it("a failed first save does not undo a later edit that lands", async () => {
    const first = heldUpsert();
    const second = heldUpsert();
    useProjectNotes.getState().update("n1", { text: "edited" }, 2);
    useProjectNotes.getState().update("n1", { pinned: true }, 3);
    first().reject("disk full");
    await flush();
    second().resolve();
    await flush();
    expect(useProjectNotes.getState().notes[0]).toMatchObject({
      pinned: true,
      text: "edited",
    });
  });

  it("when every save fails, the note goes back to the last saved copy", async () => {
    const first = heldUpsert();
    const second = heldUpsert();
    useProjectNotes.getState().update("n1", { text: "edited" }, 2);
    useProjectNotes.getState().update("n1", { pinned: true }, 3);
    first().reject("disk full");
    await flush();
    second().reject("disk full");
    await flush();
    expect(useProjectNotes.getState().notes).toEqual([note({})]);
  });

  it("a failed save does not bring back a note deleted meanwhile", async () => {
    const first = heldUpsert();
    useProjectNotes.getState().update("n1", { text: "edited" }, 2);
    useProjectNotes.getState().remove("n1");
    first().reject("disk full");
    await flush();
    expect(useProjectNotes.getState().notes).toEqual([]);
  });
});

describe("openProjectNotes", () => {
  beforeEach(() => {
    useProjectNotes.setState({ notes: [], pickedProjectId: null });
    useSessions.setState({ activeSessionId: "s1" });
    useLayout.setState({
      inspectorTab: "details",
      layout: { ...DEFAULT_LAYOUT, inspectorCollapsed: true, view: "settings" },
    });
  });

  it("puts the project's notes on screen", () => {
    openProjectNotes("p2");
    const { inspectorTab, layout } = useLayout.getState();
    expect(inspectorTab).toBe("notes");
    expect(layout.inspectorCollapsed).toBe(false);
    expect(layout.view).toBe("studio");
    expect(useProjectNotes.getState().pickedProjectId).toBe("p2");
  });

  it("leaves an open inspector open", () => {
    useLayout.setState((state) => ({
      layout: { ...state.layout, inspectorCollapsed: false },
    }));
    openProjectNotes("p2");
    expect(useLayout.getState().layout.inspectorCollapsed).toBe(false);
  });
});
