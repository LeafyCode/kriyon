import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";

vi.mock("../ipc/bridge.ts", () => ({
  deletePrompt: vi.fn(() => Promise.resolve()),
  promotePromptToCommand: vi.fn(() => Promise.resolve("/tmp/x.md")),
  recordPromptUse: vi.fn(() => Promise.resolve()),
  upsertPrompt: vi.fn(() => Promise.resolve()),
}));
vi.mock("../ui/Toast.tsx", () => ({
  showToast: vi.fn(),
}));

import { promotePromptToCommand } from "../ipc/bridge.ts";
import { usePromptLibrary } from "../state/promptLibrary.ts";
import { useSessions } from "../state/sessions.ts";
import { useUi } from "../state/ui.ts";
import type { SavedPrompt } from "../types.ts";
import { showToast } from "../ui/Toast.tsx";
import { PromptEditor, slugify } from "./PromptEditor.tsx";

beforeEach(() => {
  vi.clearAllMocks();
  useUi.setState({ promptEditorSeed: null });
  usePromptLibrary.setState({ prompts: [] });
  useSessions.setState({ activeSessionId: null, projects: [], sessions: {} });
});

test("renders nothing while closed", () => {
  render(<PromptEditor />);
  expect(screen.queryByTestId("prompt-editor")).toBeNull();
});

test("saves a new prompt from the seed", () => {
  useUi.setState({
    promptEditorSeed: { body: "B", tags: ["a"], title: "T" },
  });
  render(<PromptEditor />);
  expect(screen.getByTestId("prompt-editor")).toBeTruthy();

  fireEvent.click(screen.getByText("Save prompt"));

  const [saved] = usePromptLibrary.getState().prompts;
  expect(saved).toBeTruthy();
  expect(saved?.title).toBe("T");
  expect(saved?.body).toBe("B");
  expect(saved?.tags).toEqual(["a"]);
  expect(saved?.favourite).toBe(false);
  expect(saved?.useCount).toBe(0);
  expect(useUi.getState().promptEditorSeed).toBeNull();
});

test("editing preserves identity and stats", () => {
  const existing: SavedPrompt = {
    body: "Old body",
    createdMs: 1000,
    favourite: true,
    id: "existing-1",
    lastUsedMs: 2000,
    tags: ["x"],
    title: "Old title",
    updatedMs: 1500,
    useCount: 7,
  };
  usePromptLibrary.setState({ prompts: [existing] });
  useUi.setState({
    promptEditorSeed: {
      body: existing.body,
      id: existing.id,
      tags: existing.tags,
      title: existing.title,
    },
  });
  render(<PromptEditor />);

  fireEvent.change(screen.getByDisplayValue("Old title"), {
    target: { value: "New title" },
  });
  fireEvent.click(screen.getByText("Save prompt"));

  const saved = usePromptLibrary
    .getState()
    .prompts.find((p) => p.id === "existing-1");
  expect(saved).toBeTruthy();
  expect(saved?.id).toBe("existing-1");
  expect(saved?.title).toBe("New title");
  expect(saved?.favourite).toBe(true);
  expect(saved?.useCount).toBe(7);
  expect(saved?.lastUsedMs).toBe(2000);
  expect(saved?.createdMs).toBe(1000);
  expect(useUi.getState().promptEditorSeed).toBeNull();
});

test("delete requires an armed second click", () => {
  const existing: SavedPrompt = {
    body: "Body",
    createdMs: 1000,
    favourite: false,
    id: "existing-2",
    lastUsedMs: null,
    tags: [],
    title: "Title",
    updatedMs: 1000,
    useCount: 0,
  };
  usePromptLibrary.setState({ prompts: [existing] });
  useUi.setState({
    promptEditorSeed: {
      body: existing.body,
      id: existing.id,
      tags: existing.tags,
      title: existing.title,
    },
  });
  render(<PromptEditor />);

  const deleteButton = screen.getByText("Delete");
  fireEvent.click(deleteButton);
  expect(
    usePromptLibrary.getState().prompts.some((p) => p.id === "existing-2")
  ).toBe(true);
  expect(useUi.getState().promptEditorSeed).not.toBeNull();
  expect(screen.getByText("Really delete?")).toBeTruthy();

  fireEvent.click(screen.getByText("Really delete?"));
  expect(
    usePromptLibrary.getState().prompts.some((p) => p.id === "existing-2")
  ).toBe(false);
  expect(useUi.getState().promptEditorSeed).toBeNull();
});

test("slugify produces command-safe names", () => {
  expect(slugify("Review the Diff!")).toBe("review-the-diff");
  expect(slugify("  ")).toBe("prompt");
});

test("editing the title disarms an armed overwrite", async () => {
  useUi.setState({
    promptEditorSeed: { body: "B", tags: [], title: "T" },
  });
  vi.mocked(promotePromptToCommand).mockRejectedValueOnce(
    new Error("/t already exists")
  );
  render(<PromptEditor />);

  fireEvent.click(screen.getByText("Promote to /command"));
  await screen.findByText("Overwrite /t?");

  // The target changes — the armed confirm must not carry over to it.
  fireEvent.change(screen.getByDisplayValue("T"), {
    target: { value: "Other" },
  });
  expect(screen.queryByText("Overwrite /t?")).toBeNull();
  expect(screen.queryByText("Overwrite /other?")).toBeNull();
  expect(screen.getByText("Promote to /command")).toBeTruthy();

  fireEvent.click(screen.getByText("Promote to /command"));
  await waitFor(() => {
    expect(promotePromptToCommand).toHaveBeenLastCalledWith(
      null,
      "other",
      "Other",
      "B",
      false
    );
  });
});

test("promote calls the bridge with the slug and toasts the path", async () => {
  useUi.setState({
    promptEditorSeed: { body: "B", tags: [], title: "T" },
  });
  render(<PromptEditor />);

  fireEvent.click(screen.getByText("Promote to /command"));

  await waitFor(() => {
    expect(promotePromptToCommand).toHaveBeenCalledWith(
      null,
      "t",
      "T",
      "B",
      false
    );
  });
  await waitFor(() => {
    expect(showToast).toHaveBeenCalledWith("Wrote /tmp/x.md");
  });
});
