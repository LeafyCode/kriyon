import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../ipc/bridge.ts", () => ({
  deleteProjectNote: vi.fn(() => Promise.resolve()),
  upsertProjectNote: vi.fn((note: unknown) => Promise.resolve(note)),
}));

import { deleteProjectNote, upsertProjectNote } from "../ipc/bridge.ts";
import { useProjectNotes } from "../state/projectNotes.ts";
import { useSessions } from "../state/sessions.ts";
import type { ProjectNote } from "../types.ts";
import { NotesTab } from "./NotesTab.tsx";

const NEVER_SENT_RE = /never sent to Claude/;
const IDEAS_FILTER_RE = /^Ideas/;
const DONE_FOLD_RE = /^Done/;

function note(over: Partial<ProjectNote>): ProjectNote {
  return {
    body: "",
    createdMs: Date.now(),
    doneAt: null,
    id: "n1",
    kind: "todo",
    pinned: false,
    projectId: "p1",
    text: "Write the ADR",
    updatedMs: Date.now(),
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  useProjectNotes.setState({ notes: [], pickedProjectId: null });
  useSessions.setState({
    projects: [
      { color: null, id: "p1", name: "kriyon", path: "/k", setupCommand: null },
    ],
  });
});

afterEach(cleanup);

describe("NotesTab", () => {
  it("explains itself when the project has no notes", () => {
    render(<NotesTab projectId="p1" />);
    expect(screen.getByText("Nothing planned here yet")).toBeTruthy();
    expect(screen.getByText(NEVER_SENT_RE)).toBeTruthy();
  });

  it("adds a note of the picked kind on Enter and clears the box", () => {
    render(<NotesTab projectId="p1" />);
    fireEvent.click(screen.getByRole("button", { name: "Idea" }));
    const input = screen.getByLabelText("New note") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Split view" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(input.value).toBe("");
    const [added] = useProjectNotes.getState().notes;
    expect(added).toMatchObject({
      kind: "idea",
      projectId: "p1",
      text: "Split view",
    });
    expect(upsertProjectNote).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Split view")).toBeTruthy();
  });

  it("shows only this project's notes", () => {
    useProjectNotes.setState({
      notes: [note({}), note({ id: "n2", projectId: "p2", text: "Elsewhere" })],
    });
    render(<NotesTab projectId="p1" />);
    expect(screen.getByText("Write the ADR")).toBeTruthy();
    expect(screen.queryByText("Elsewhere")).toBeNull();
  });

  it("filters by kind", () => {
    useProjectNotes.setState({
      notes: [note({}), note({ id: "n2", kind: "idea", text: "Split view" })],
    });
    render(<NotesTab projectId="p1" />);
    fireEvent.click(screen.getByRole("button", { name: IDEAS_FILTER_RE }));
    expect(screen.getByText("Split view")).toBeTruthy();
    expect(screen.queryByText("Write the ADR")).toBeNull();
  });

  it("ticks a todo off into the folded Done list", () => {
    useProjectNotes.setState({ notes: [note({})] });
    render(<NotesTab projectId="p1" />);
    fireEvent.click(screen.getByLabelText('Mark "Write the ADR" done'));

    expect(screen.queryByText("Write the ADR")).toBeNull();
    const fold = screen.getByRole("button", { name: DONE_FOLD_RE });
    expect(fold.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(fold);
    expect(screen.getByText("Write the ADR")).toBeTruthy();
  });

  it("opens a note, saves an edit on Back, and returns to the list", () => {
    useProjectNotes.setState({ notes: [note({})] });
    render(<NotesTab projectId="p1" />);
    fireEvent.click(screen.getByText("Write the ADR"));

    fireEvent.change(screen.getByLabelText("More detail"), {
      target: { value: "Why, then what" },
    });
    fireEvent.click(screen.getByLabelText("Back to notes"));

    expect(useProjectNotes.getState().notes[0].body).toBe("Why, then what");
    expect(screen.getByTestId("notes-tab")).toBeTruthy();
  });

  it("keeps a body typed under a cleared title, and puts the title back", () => {
    useProjectNotes.setState({ notes: [note({})] });
    render(<NotesTab projectId="p1" />);
    fireEvent.click(screen.getByText("Write the ADR"));
    const title = screen.getByLabelText("Note text") as HTMLInputElement;
    fireEvent.change(title, { target: { value: "" } });
    fireEvent.blur(title);
    expect(title.value).toBe("Write the ADR");

    fireEvent.change(screen.getByLabelText("More detail"), {
      target: { value: "Why, then what" },
    });
    fireEvent.click(screen.getByLabelText("Back to notes"));
    expect(useProjectNotes.getState().notes[0]).toMatchObject({
      body: "Why, then what",
      text: "Write the ADR",
    });
  });

  it("saves an edit when the open note is unmounted without a blur", () => {
    useProjectNotes.setState({ notes: [note({})] });
    const { unmount } = render(<NotesTab projectId="p1" />);
    fireEvent.click(screen.getByText("Write the ADR"));
    fireEvent.change(screen.getByLabelText("Note text"), {
      target: { value: "Write ADR 0053" },
    });
    unmount();
    expect(useProjectNotes.getState().notes[0].text).toBe("Write ADR 0053");
  });

  it("deletes a note only after confirming", () => {
    useProjectNotes.setState({ notes: [note({})] });
    render(<NotesTab projectId="p1" />);
    fireEvent.click(screen.getByText("Write the ADR"));
    fireEvent.click(screen.getByLabelText("Delete note"));
    expect(deleteProjectNote).not.toHaveBeenCalled();

    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    });
    expect(deleteProjectNote).toHaveBeenCalledWith("n1");
    expect(useProjectNotes.getState().notes).toEqual([]);
  });

  it("pins a note to the top", () => {
    useProjectNotes.setState({
      notes: [
        note({ createdMs: 1, id: "old", text: "Older" }),
        note({ createdMs: 2, id: "new", text: "Newer" }),
      ],
    });
    render(<NotesTab projectId="p1" />);
    fireEvent.click(screen.getByLabelText('Pin "Older" to the top'));
    const rows = screen.getAllByTestId("note-row").map((r) => r.textContent);
    expect(rows[0]).toContain("Older");
  });
});
