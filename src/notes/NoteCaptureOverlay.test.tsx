import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../ipc/bridge.ts", () => ({
  deleteProjectNote: vi.fn(() => Promise.resolve()),
  upsertProjectNote: vi.fn((note: unknown) => Promise.resolve(note)),
}));
vi.mock("../ui/Toast.tsx", () => ({ showToast: vi.fn() }));

import { useProjectNotes } from "../state/projectNotes.ts";
import { type UiSession, useSessions } from "../state/sessions.ts";
import { useUi } from "../state/ui.ts";
import { showToast } from "../ui/Toast.tsx";
import { NoteCaptureOverlay } from "./NoteCaptureOverlay.tsx";

const PROJECTS = [
  { color: null, id: "p1", name: "kriyon", path: "/k", setupCommand: null },
  { color: null, id: "p2", name: "leafy-site", path: "/l", setupCommand: null },
];

function pressCapture(): void {
  fireEvent.keyDown(window, { key: "N", metaKey: true, shiftKey: true });
}

beforeEach(() => {
  vi.clearAllMocks();
  useUi.setState({ noteCaptureOpen: false, paletteOpen: false });
  useProjectNotes.setState({ notes: [], pickedProjectId: null });
  useSessions.setState({
    activeSessionId: "s2",
    projects: PROJECTS,
    sessions: { s2: { id: "s2", projectId: "p2" } as UiSession },
  });
});

afterEach(cleanup);

describe("NoteCaptureOverlay", () => {
  it("opens on ⌘⇧N, closing any other overlay", () => {
    useUi.setState({ paletteOpen: true });
    render(<NoteCaptureOverlay />);
    pressCapture();
    expect(useUi.getState().noteCaptureOpen).toBe(true);
    expect(useUi.getState().paletteOpen).toBe(false);
    expect(screen.getByRole("dialog", { name: "Add a note" })).toBeTruthy();
  });

  it("files the note under the active session's project by default", () => {
    render(<NoteCaptureOverlay />);
    pressCapture();
    const input = screen.getByLabelText("Note");
    fireEvent.change(input, { target: { value: "Try a split view" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(useProjectNotes.getState().notes[0]).toMatchObject({
      kind: "todo",
      projectId: "p2",
      text: "Try a split view",
    });
    expect(useUi.getState().noteCaptureOpen).toBe(false);
    expect(showToast).toHaveBeenCalledWith("Todo added to leafy-site");
  });

  it("can file it under another project and kind", () => {
    render(<NoteCaptureOverlay />);
    pressCapture();
    fireEvent.change(screen.getByLabelText("Project"), {
      target: { value: "p1" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Idea" }));
    fireEvent.change(screen.getByLabelText("Note"), {
      target: { value: "Weekly digest" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));

    expect(useProjectNotes.getState().notes[0]).toMatchObject({
      kind: "idea",
      projectId: "p1",
    });
  });

  it("stays open on blank text", () => {
    render(<NoteCaptureOverlay />);
    pressCapture();
    fireEvent.keyDown(screen.getByLabelText("Note"), { key: "Enter" });
    expect(useUi.getState().noteCaptureOpen).toBe(true);
    expect(useProjectNotes.getState().notes).toEqual([]);
  });

  it("says why it can't open with no project yet", () => {
    useSessions.setState({ activeSessionId: null, projects: [], sessions: {} });
    render(<NoteCaptureOverlay />);
    pressCapture();
    expect(useUi.getState().noteCaptureOpen).toBe(false);
    expect(showToast).toHaveBeenCalledWith(
      "Add a project first — notes belong to a project",
      "error"
    );
  });
});
