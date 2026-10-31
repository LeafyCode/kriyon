import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { useLayout } from "../state/layout.ts";
import { usePromptLibrary } from "../state/promptLibrary.ts";
import { useSessions } from "../state/sessions.ts";
import { useUi } from "../state/ui.ts";
import { CommandPalette } from "./CommandPalette.tsx";

vi.mock("../ipc/bridge.ts", () => ({
  deletePrompt: vi.fn(() => Promise.resolve()),
  importCommands: vi.fn(() => Promise.resolve([])),
  recordPromptUse: vi.fn(() => Promise.resolve()),
  upsertPrompt: vi.fn(() => Promise.resolve()),
}));

const PLACEHOLDER = "Jump to a session or run a command…";

beforeEach(() => {
  useUi.setState({
    paletteOpen: false,
    promptEditorSeed: null,
    promptPickerOpen: false,
  });
  useSessions.setState({
    activeSessionId: null,
    events: {},
    projects: [],
    sessions: {},
  });
  usePromptLibrary.setState({ prompts: [] });
  vi.clearAllMocks();
});

afterEach(() => {
  useLayout.getState().setMenuBarMode("grouped");
  useLayout.getState().setTranscriptView("raw");
});

function seed(): void {
  const state = useSessions.getState();
  state.addSession({
    archivedAt: null,
    baselineOid: null,
    claudeSessionId: null,
    createdAt: 1,
    cwd: "/alpha",
    id: "s1",
    projectId: "default",
    status: "idle",
    summary: "",
    title: "Alpha Session",
    titleLocked: false,
    worktreePath: null,
  });
  state.addSession({
    archivedAt: null,
    baselineOid: null,
    claudeSessionId: null,
    createdAt: 2,
    cwd: "/beta",
    id: "s2",
    projectId: "default",
    status: "idle",
    summary: "",
    title: "Beta Session",
    titleLocked: false,
    worktreePath: null,
  });
}

test("pressing Cmd+K opens the palette", () => {
  render(<CommandPalette />);

  expect(screen.queryByPlaceholderText(PLACEHOLDER)).toBeNull();

  fireEvent.keyDown(window, { key: "k", metaKey: true });

  expect(screen.getByPlaceholderText(PLACEHOLDER)).toBeInTheDocument();
});

test("typing filters the combined list to matching items", () => {
  seed();
  render(<CommandPalette />);
  fireEvent.keyDown(window, { key: "k", metaKey: true });

  fireEvent.change(screen.getByPlaceholderText(PLACEHOLDER), {
    target: { value: "Alpha" },
  });

  expect(screen.getByText("Alpha Session")).toBeInTheDocument();
  expect(screen.queryByText("Beta Session")).toBeNull();
});

test("pressing Enter on a highlighted session activates it and closes", () => {
  seed();
  const spy = vi.spyOn(useSessions.getState(), "setActiveSession");
  render(<CommandPalette />);
  fireEvent.keyDown(window, { key: "k", metaKey: true });

  const input = screen.getByPlaceholderText(PLACEHOLDER);
  fireEvent.change(input, { target: { value: "Beta" } });
  fireEvent.keyDown(input, { key: "Enter" });

  expect(spy).toHaveBeenCalledWith("s2");
  expect(screen.queryByPlaceholderText(PLACEHOLDER)).toBeNull();
});

test("activating a session from the palette returns to the prior view", () => {
  // Same rule as the sidebar's session rows: picking a session is a request
  // for that session, not for the Changes tab of it.
  seed();
  useLayout.getState().setTranscriptView("changes");
  render(<CommandPalette />);
  fireEvent.keyDown(window, { key: "k", metaKey: true });

  const input = screen.getByPlaceholderText(PLACEHOLDER);
  fireEvent.change(input, { target: { value: "Beta" } });
  fireEvent.keyDown(input, { key: "Enter" });

  expect(useLayout.getState().layout.transcriptView).toBe("raw");
});

test("Esc closes the palette", () => {
  render(<CommandPalette />);
  fireEvent.keyDown(window, { key: "k", metaKey: true });
  expect(screen.getByPlaceholderText(PLACEHOLDER)).toBeInTheDocument();

  fireEvent.keyDown(screen.getByPlaceholderText(PLACEHOLDER), {
    key: "Escape",
  });

  expect(screen.queryByPlaceholderText(PLACEHOLDER)).toBeNull();
});

test("typing 'prompt' surfaces the prompt verbs", () => {
  render(<CommandPalette />);
  fireEvent.keyDown(window, { key: "k", metaKey: true });

  fireEvent.change(screen.getByPlaceholderText(PLACEHOLDER), {
    target: { value: "prompt" },
  });

  expect(screen.getByText("Insert prompt…")).toBeInTheDocument();
  expect(screen.getByText("Save last prompt…")).toBeInTheDocument();
});

test("running 'Insert prompt…' opens the prompt picker", () => {
  render(<CommandPalette />);
  fireEvent.keyDown(window, { key: "k", metaKey: true });

  fireEvent.change(screen.getByPlaceholderText(PLACEHOLDER), {
    target: { value: "Insert prompt" },
  });
  fireEvent.click(screen.getByText("Insert prompt…"));

  expect(useUi.getState().promptPickerOpen).toBe(true);
});

test("running 'Save last prompt…' opens the editor seeded with the last prompt event", () => {
  useSessions.setState({
    activeSessionId: "s1",
    events: {
      s1: [
        { id: "e1", kind: "prompt", text: "First prompt" },
        { id: "e2", kind: "assistant", text: "reply" },
        { id: "e3", kind: "prompt", text: "Second prompt\nmore body" },
      ],
    },
  });
  render(<CommandPalette />);
  fireEvent.keyDown(window, { key: "k", metaKey: true });

  fireEvent.change(screen.getByPlaceholderText(PLACEHOLDER), {
    target: { value: "Save last prompt" },
  });
  fireEvent.click(screen.getByText("Save last prompt…"));

  expect(useUi.getState().promptEditorSeed).toEqual({
    body: "Second prompt\nmore body",
    tags: [],
    title: "Second prompt",
  });
});

test("running 'Import prompts from /commands…' imports and closes the palette", async () => {
  const bridge = await import("../ipc/bridge.ts");
  vi.mocked(bridge.importCommands).mockResolvedValueOnce([
    { body: "B", description: "Review", name: "review" },
  ]);
  render(<CommandPalette />);
  fireEvent.keyDown(window, { key: "k", metaKey: true });

  fireEvent.change(screen.getByPlaceholderText(PLACEHOLDER), {
    target: { value: "Import prompts" },
  });
  fireEvent.click(screen.getByText("Import prompts from /commands…"));

  expect(screen.queryByPlaceholderText(PLACEHOLDER)).toBeNull();
  await waitFor(() => {
    expect(usePromptLibrary.getState().prompts).toHaveLength(1);
  });
  expect(usePromptLibrary.getState().prompts[0].title).toBe("Review");
});

test("typing 'theme' surfaces one command per shipped theme and applies it", () => {
  render(<CommandPalette />);
  fireEvent.keyDown(window, { key: "k", metaKey: true });

  fireEvent.change(screen.getByPlaceholderText(PLACEHOLDER), {
    target: { value: "theme" },
  });

  expect(screen.getByText("Theme: Indigo")).toBeInTheDocument();
  expect(screen.getByText("Theme: Cool blue")).toBeInTheDocument();
  fireEvent.click(screen.getByText("Theme: Teal"));

  expect(useLayout.getState().layout.themeId).toBe("teal");
});

test("menu bar mode commands set the layout mode", () => {
  render(<CommandPalette />);
  fireEvent.keyDown(window, { key: "k", metaKey: true });

  fireEvent.change(screen.getByPlaceholderText(PLACEHOLDER), {
    target: { value: "menu bar" },
  });

  expect(screen.getByText("Menu bar: Grouped view")).toBeInTheDocument();
  fireEvent.click(screen.getByText("Menu bar: Compact view"));

  expect(useLayout.getState().layout.menuBarMode).toBe("compact");
});

test("the transcript-view command reaches the Changes view and back", () => {
  useLayout.getState().setTranscriptView("raw");
  render(<CommandPalette />);
  fireEvent.keyDown(window, { key: "k", metaKey: true });
  fireEvent.change(screen.getByPlaceholderText(PLACEHOLDER), {
    target: { value: "Toggle Files" },
  });

  fireEvent.click(screen.getByText("Toggle Files / Session view"));
  expect(useLayout.getState().layout.transcriptView).toBe("changes");

  // Palette closes on run; reopen to run it again.
  fireEvent.keyDown(window, { key: "k", metaKey: true });
  fireEvent.change(screen.getByPlaceholderText(PLACEHOLDER), {
    target: { value: "Toggle Files" },
  });
  fireEvent.click(screen.getByText("Toggle Files / Session view"));
  expect(useLayout.getState().layout.transcriptView).toBe("raw");
});

test("sidebar mode commands set the layout mode", () => {
  render(<CommandPalette />);
  fireEvent.keyDown(window, { key: "k", metaKey: true });

  fireEvent.change(screen.getByPlaceholderText(PLACEHOLDER), {
    target: { value: "sidebar" },
  });

  expect(screen.getByText("Sidebar: Calm view")).toBeInTheDocument();
  fireEvent.click(screen.getByText("Sidebar: Triage view"));

  expect(useLayout.getState().layout.sidebarMode).toBe("triage");
});
