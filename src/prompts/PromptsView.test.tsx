import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";

vi.mock("../ipc/bridge.ts", () => ({
  deletePrompt: vi.fn(() => Promise.resolve()),
  recordPromptUse: vi.fn(() => Promise.resolve()),
  upsertPrompt: vi.fn(() => Promise.resolve()),
}));
vi.mock("../ui/Toast.tsx", () => ({ showToast: vi.fn() }));
vi.mock("../state/promptLibrary.ts", async (orig) => {
  const actual = await orig<typeof import("../state/promptLibrary.ts")>();
  return {
    ...actual,
    importPromptsFromCommands: vi.fn(() => Promise.resolve()),
  };
});

import { useDrafts } from "../state/drafts.ts";
import {
  importPromptsFromCommands,
  usePromptLibrary,
} from "../state/promptLibrary.ts";
import { useSessions } from "../state/sessions.ts";
import { useUi } from "../state/ui.ts";
import type { SavedPrompt } from "../types.ts";
import { showToast } from "../ui/Toast.tsx";
import { PromptsView } from "./PromptsView.tsx";

function prompt(over: Partial<SavedPrompt>): SavedPrompt {
  return {
    body: "body",
    createdMs: 1,
    favourite: false,
    id: "p1",
    lastUsedMs: null,
    tags: [],
    title: "title",
    updatedMs: 1,
    useCount: 0,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  useUi.setState({ promptEditorSeed: null });
  usePromptLibrary.setState({ prompts: [] });
  useSessions.setState({ activeSessionId: null, sessions: {} });
  useDrafts.setState({ drafts: {}, insertRequest: null });
});

test("lists prompts favourites-first", () => {
  usePromptLibrary.setState({
    prompts: [
      prompt({ id: "a", title: "Alpha" }),
      prompt({ favourite: true, id: "b", title: "Bravo" }),
    ],
  });
  render(<PromptsView />);
  const titles = screen
    .getAllByTestId("prompts-row-title")
    .map((n) => n.textContent);
  expect(titles[0]).toContain("Bravo");
});

test("search filters by title/tags/body", () => {
  usePromptLibrary.setState({
    prompts: [
      prompt({ id: "a", title: "Alpha" }),
      prompt({ id: "b", title: "Bravo" }),
    ],
  });
  render(<PromptsView />);
  fireEvent.change(screen.getByPlaceholderText("Search prompts…"), {
    target: { value: "brav" },
  });
  expect(screen.getByText("Bravo")).toBeInTheDocument();
  expect(screen.queryByText("Alpha")).toBeNull();
});

test("insert writes the active session draft and toasts, never sends", () => {
  usePromptLibrary.setState({
    prompts: [prompt({ body: "hi", id: "a", title: "Alpha" })],
  });
  useSessions.setState({ activeSessionId: "s1" });
  render(<PromptsView />);
  fireEvent.click(screen.getByLabelText("Insert prompt"));
  expect(useDrafts.getState().insertRequest?.text).toBe("hi");
  expect(useDrafts.getState().insertRequest?.sessionId).toBe("s1");
  expect(showToast).toHaveBeenCalledWith("Inserted into the session draft");
});

test("insert is disabled with no active session", () => {
  usePromptLibrary.setState({ prompts: [prompt({ id: "a", title: "Alpha" })] });
  render(<PromptsView />);
  expect(screen.getByLabelText("Insert prompt")).toBeDisabled();
});

test("+ New opens a blank editor", () => {
  render(<PromptsView />);
  fireEvent.click(screen.getByRole("button", { name: "New prompt" }));
  expect(useUi.getState().promptEditorSeed).not.toBeNull();
  expect(useUi.getState().promptEditorSeed?.id).toBeUndefined();
});

test("Import runs the command importer", () => {
  render(<PromptsView />);
  fireEvent.click(
    screen.getByRole("button", { name: "Import from /commands" })
  );
  expect(importPromptsFromCommands).toHaveBeenCalledTimes(1);
});

test("empty library shows the shared affordance copy", () => {
  render(<PromptsView />);
  expect(
    screen.getByText("No saved prompts yet", { exact: false })
  ).toBeInTheDocument();
});
