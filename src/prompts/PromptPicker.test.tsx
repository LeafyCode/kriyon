import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";

vi.mock("../ipc/bridge.ts", () => ({
  deletePrompt: vi.fn(() => Promise.resolve()),
  readClipboard: vi.fn(() => Promise.resolve("from-rust")),
  recordPromptUse: vi.fn(() => Promise.resolve()),
  upsertPrompt: vi.fn(() => Promise.resolve()),
}));
vi.mock("../ui/Toast.tsx", () => ({
  showToast: vi.fn(),
}));

import { readClipboard } from "../ipc/bridge.ts";
import { useDrafts } from "../state/drafts.ts";
import { DEFAULT_LAYOUT, useLayout } from "../state/layout.ts";
import { usePromptLibrary } from "../state/promptLibrary.ts";
import { useSessions } from "../state/sessions.ts";
import { useUi } from "../state/ui.ts";
import type { SavedPrompt } from "../types.ts";
import { showToast } from "../ui/Toast.tsx";
import { PromptPicker } from "./PromptPicker.tsx";

const SEARCH_PLACEHOLDER = "Search saved prompts…";

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
  useUi.setState({ promptEditorSeed: null, promptPickerOpen: false });
  usePromptLibrary.setState({ prompts: [] });
  useSessions.setState({ activeSessionId: null, projects: [], sessions: {} });
  useLayout.setState({ layout: DEFAULT_LAYOUT });
  useDrafts.setState({ drafts: {}, insertRequest: null });
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { readText: () => Promise.resolve("clip") },
  });
});

test("renders nothing while closed", () => {
  render(<PromptPicker />);
  expect(screen.queryByTestId("prompt-picker")).toBeNull();
});

test("empty library shows the save/import affordance copy", () => {
  useUi.setState({ promptPickerOpen: true });
  render(<PromptPicker />);
  expect(
    screen.getByText(
      'No saved prompts yet — use "Save last prompt…" or import your /commands from the palette.'
    )
  ).toBeInTheDocument();
});

test("filters by title and tag and orders favourites first", () => {
  usePromptLibrary.setState({
    prompts: [
      prompt({ id: "a", tags: ["urgent"], title: "Alpha" }),
      prompt({ favourite: true, id: "b", tags: [], title: "Beta" }),
      prompt({ id: "c", tags: ["urgent"], title: "Gamma" }),
    ],
  });
  useUi.setState({ promptPickerOpen: true });
  render(<PromptPicker />);

  const rows = screen
    .getAllByRole("button")
    .filter((btn) =>
      ["Alpha", "Beta", "Gamma"].some((title) =>
        btn.textContent?.includes(title)
      )
    );
  expect(rows[0]?.textContent).toContain("Beta");

  fireEvent.change(screen.getByPlaceholderText(SEARCH_PLACEHOLDER), {
    target: { value: "urgent" },
  });

  const list = within(screen.getByTestId("prompt-picker-list"));
  expect(list.getByText("Alpha")).toBeInTheDocument();
  expect(list.getByText("Gamma")).toBeInTheDocument();
  expect(list.queryByText("Beta")).toBeNull();
});

test("Enter on a plain prompt inserts into the draft mailbox, marks use, closes", async () => {
  usePromptLibrary.setState({
    prompts: [prompt({ body: "Just do it", id: "p1", title: "Plain" })],
  });
  useSessions.setState({ activeSessionId: "s1" });
  useUi.setState({ promptPickerOpen: true });
  render(<PromptPicker />);

  fireEvent.keyDown(screen.getByPlaceholderText(SEARCH_PLACEHOLDER), {
    key: "Enter",
  });

  await waitFor(() => {
    expect(useDrafts.getState().insertRequest).toMatchObject({
      sessionId: "s1",
      text: "Just do it",
    });
  });
  expect(usePromptLibrary.getState().prompts[0]?.useCount).toBe(1);
  expect(useUi.getState().promptPickerOpen).toBe(false);
});

test("a templated prompt enters fill stage and resolves fields", async () => {
  usePromptLibrary.setState({
    prompts: [
      prompt({ body: "Fix {bug} in {file}", id: "p1", title: "Templated" }),
    ],
  });
  useSessions.setState({ activeSessionId: "s1" });
  useUi.setState({ promptPickerOpen: true });
  render(<PromptPicker />);

  fireEvent.keyDown(screen.getByPlaceholderText(SEARCH_PLACEHOLDER), {
    key: "Enter",
  });

  const bugField = await screen.findByLabelText("bug");
  const fileField = screen.getByLabelText("file");
  fireEvent.change(bugField, { target: { value: "the-race" } });
  fireEvent.change(fileField, { target: { value: "store.rs" } });
  fireEvent.keyDown(fileField, { key: "Enter" });

  await waitFor(() => {
    expect(useDrafts.getState().insertRequest?.text).toBe(
      "Fix the-race in store.rs"
    );
  });
  expect(useUi.getState().promptPickerOpen).toBe(false);
});

test("cmd+F toggles favourite; cmd+E opens the editor seeded", () => {
  usePromptLibrary.setState({
    prompts: [prompt({ body: "Body", id: "p1", tags: ["x"], title: "T" })],
  });
  useUi.setState({ promptPickerOpen: true });
  render(<PromptPicker />);

  const input = screen.getByPlaceholderText(SEARCH_PLACEHOLDER);
  fireEvent.keyDown(input, { key: "f", metaKey: true });
  expect(usePromptLibrary.getState().prompts[0]?.favourite).toBe(true);

  fireEvent.keyDown(input, { key: "e", metaKey: true });
  expect(useUi.getState().promptEditorSeed).toEqual({
    body: "Body",
    id: "p1",
    tags: ["x"],
    title: "T",
  });
});

test("cmd+Backspace arms, then a second press deletes the highlighted prompt", () => {
  usePromptLibrary.setState({
    prompts: [prompt({ id: "p1", title: "Doomed" })],
  });
  useUi.setState({ promptPickerOpen: true });
  render(<PromptPicker />);

  const input = screen.getByPlaceholderText(SEARCH_PLACEHOLDER);
  fireEvent.keyDown(input, { key: "Backspace", metaKey: true });
  expect(screen.getByLabelText("Confirm delete")).toBeInTheDocument();
  expect(usePromptLibrary.getState().prompts).toHaveLength(1);

  fireEvent.keyDown(input, { key: "Backspace", metaKey: true });
  expect(usePromptLibrary.getState().prompts).toHaveLength(0);
});

test("moving the highlight disarms a pending delete", () => {
  usePromptLibrary.setState({
    prompts: [
      prompt({ id: "a", lastUsedMs: 200, title: "Alpha" }),
      prompt({ id: "b", lastUsedMs: 100, title: "Beta" }),
    ],
  });
  useUi.setState({ promptPickerOpen: true });
  render(<PromptPicker />);

  const input = screen.getByPlaceholderText(SEARCH_PLACEHOLDER);
  fireEvent.keyDown(input, { key: "Backspace", metaKey: true });
  expect(screen.getByLabelText("Confirm delete")).toBeInTheDocument();

  fireEvent.keyDown(input, { key: "ArrowDown" });
  expect(screen.queryByLabelText("Confirm delete")).toBeNull();

  // ⌘⌫ on the new highlight arms it — it must not delete anything yet.
  fireEvent.keyDown(input, { key: "Backspace", metaKey: true });
  expect(usePromptLibrary.getState().prompts).toHaveLength(2);
  const armedRow = screen
    .getByLabelText("Confirm delete")
    .closest("[data-active]");
  expect(armedRow?.textContent).toContain("Beta");
});

test("moving the highlight by hover disarms a pending delete", () => {
  usePromptLibrary.setState({
    prompts: [
      prompt({ id: "a", lastUsedMs: 200, title: "Alpha" }),
      prompt({ id: "b", lastUsedMs: 100, title: "Beta" }),
    ],
  });
  useUi.setState({ promptPickerOpen: true });
  render(<PromptPicker />);

  fireEvent.keyDown(screen.getByPlaceholderText(SEARCH_PLACEHOLDER), {
    key: "Backspace",
    metaKey: true,
  });
  expect(screen.getByLabelText("Confirm delete")).toBeInTheDocument();

  const betaLabel = within(screen.getByTestId("prompt-picker-list"))
    .getByText("Beta")
    .closest("button") as HTMLButtonElement;
  fireEvent.mouseEnter(betaLabel);
  expect(screen.queryByLabelText("Confirm delete")).toBeNull();
});

test("a second Enter while the clipboard read is pending does not double-insert", async () => {
  let resolveClip!: (value: string) => void;
  const pendingRead = new Promise<string>((resolve) => {
    resolveClip = resolve;
  });
  vi.mocked(readClipboard).mockReturnValueOnce(pendingRead);
  const requestInsert = vi.fn();
  useDrafts.setState({ requestInsert });
  usePromptLibrary.setState({
    prompts: [prompt({ body: "Paste: {clipboard}", id: "p1", title: "Clip" })],
  });
  useSessions.setState({ activeSessionId: "s1" });
  useUi.setState({ promptPickerOpen: true });
  render(<PromptPicker />);

  const input = screen.getByPlaceholderText(SEARCH_PLACEHOLDER);
  fireEvent.keyDown(input, { key: "Enter" });
  fireEvent.keyDown(input, { key: "Enter" });
  resolveClip("clip");

  await waitFor(() => {
    expect(requestInsert).toHaveBeenCalledWith("s1", "Paste: clip");
  });
  expect(requestInsert).toHaveBeenCalledTimes(1);
  expect(usePromptLibrary.getState().prompts[0]?.useCount).toBe(1);
});

test("skips delivering the insert if the active session changes while the clipboard read is pending", async () => {
  let resolveClip!: (value: string) => void;
  const pendingRead = new Promise<string>((resolve) => {
    resolveClip = resolve;
  });
  vi.mocked(readClipboard).mockReturnValueOnce(pendingRead);
  const requestInsert = vi.fn();
  useDrafts.setState({ requestInsert });
  usePromptLibrary.setState({
    prompts: [prompt({ body: "Paste: {clipboard}", id: "p1", title: "Clip" })],
  });
  useSessions.setState({ activeSessionId: "s1" });
  useUi.setState({ promptPickerOpen: true });
  render(<PromptPicker />);

  fireEvent.keyDown(screen.getByPlaceholderText(SEARCH_PLACEHOLDER), {
    key: "Enter",
  });
  // The user switches sessions while the (permission-gated) clipboard read
  // is still pending.
  useSessions.setState({ activeSessionId: "s2" });
  resolveClip("clip");

  await waitFor(() => {
    expect(useUi.getState().promptPickerOpen).toBe(false);
  });
  expect(requestInsert).not.toHaveBeenCalled();
  expect(usePromptLibrary.getState().prompts[0]?.useCount).toBe(0);
});

test("toasts on insert when the app is in command view (no composer mounted)", async () => {
  usePromptLibrary.setState({
    prompts: [prompt({ body: "Just do it", id: "p1", title: "Plain" })],
  });
  useSessions.setState({ activeSessionId: "s1" });
  useLayout.setState((state) => ({
    layout: { ...state.layout, view: "command" },
  }));
  useUi.setState({ promptPickerOpen: true });
  render(<PromptPicker />);

  fireEvent.keyDown(screen.getByPlaceholderText(SEARCH_PLACEHOLDER), {
    key: "Enter",
  });

  await waitFor(() => {
    expect(showToast).toHaveBeenCalledWith("Inserted into the session draft");
  });
});

test("escape in fill stage returns to search; escape in search closes", async () => {
  usePromptLibrary.setState({
    prompts: [prompt({ body: "Fix {bug}", id: "p1", title: "Templated" })],
  });
  useUi.setState({ promptPickerOpen: true });
  render(<PromptPicker />);

  fireEvent.keyDown(screen.getByPlaceholderText(SEARCH_PLACEHOLDER), {
    key: "Enter",
  });
  const bugField = await screen.findByLabelText("bug");
  fireEvent.keyDown(bugField, { key: "Escape" });

  expect(screen.getByPlaceholderText(SEARCH_PLACEHOLDER)).toBeInTheDocument();
  expect(useUi.getState().promptPickerOpen).toBe(true);

  fireEvent.keyDown(screen.getByPlaceholderText(SEARCH_PLACEHOLDER), {
    key: "Escape",
  });
  expect(useUi.getState().promptPickerOpen).toBe(false);
});

test("{clipboard} resolves via the Rust bridge, not navigator.clipboard", async () => {
  const requestInsert = vi.fn();
  useDrafts.setState({ requestInsert });
  usePromptLibrary.setState({
    prompts: [prompt({ body: "holds: {clipboard}", id: "c1", title: "Clip" })],
  });
  useSessions.setState({ activeSessionId: "s1" });
  useUi.setState({ promptPickerOpen: true });
  render(<PromptPicker />);

  fireEvent.click(
    within(screen.getByTestId("prompt-picker-list")).getByText("Clip")
  );

  await waitFor(() => {
    expect(requestInsert).toHaveBeenCalledWith("s1", "holds: from-rust");
  });
  expect(readClipboard).toHaveBeenCalledTimes(1);
});

test("clipboard read failure inserts empty and toasts", async () => {
  vi.mocked(readClipboard).mockRejectedValueOnce(new Error("no pasteboard"));
  const requestInsert = vi.fn();
  useDrafts.setState({ requestInsert });
  usePromptLibrary.setState({
    prompts: [prompt({ body: "holds: {clipboard}", id: "c2", title: "Clip2" })],
  });
  useSessions.setState({ activeSessionId: "s1" });
  useUi.setState({ promptPickerOpen: true });
  render(<PromptPicker />);

  fireEvent.click(
    within(screen.getByTestId("prompt-picker-list")).getByText("Clip2")
  );

  await waitFor(() => {
    expect(requestInsert).toHaveBeenCalledWith("s1", "holds: ");
  });
  expect(showToast).toHaveBeenCalledWith(
    "Could not read the clipboard",
    "error"
  );
});

test("picker row favourite button toggles via the store", () => {
  usePromptLibrary.setState({ prompts: [prompt({ id: "r1", title: "Row" })] });
  useUi.setState({ promptPickerOpen: true });
  render(<PromptPicker />);
  fireEvent.click(
    within(screen.getByTestId("prompt-picker-list")).getByLabelText("Favourite")
  );
  expect(usePromptLibrary.getState().prompts[0].favourite).toBe(true);
});

test("picker row edit button opens the editor for that prompt", () => {
  usePromptLibrary.setState({
    prompts: [prompt({ body: "b", id: "r2", title: "EditMe" })],
  });
  useUi.setState({ promptPickerOpen: true });
  render(<PromptPicker />);
  fireEvent.click(
    within(screen.getByTestId("prompt-picker-list")).getByLabelText(
      "Edit prompt"
    )
  );
  expect(useUi.getState().promptEditorSeed?.id).toBe("r2");
});

test("picker row delete is two-click armed then removes", () => {
  usePromptLibrary.setState({ prompts: [prompt({ id: "r3", title: "Del" })] });
  useUi.setState({ promptPickerOpen: true });
  render(<PromptPicker />);
  const list = () => screen.getByTestId("prompt-picker-list");
  fireEvent.click(within(list()).getByLabelText("Delete prompt"));
  expect(usePromptLibrary.getState().prompts).toHaveLength(1);
  fireEvent.click(within(list()).getByLabelText("Confirm delete"));
  expect(usePromptLibrary.getState().prompts).toHaveLength(0);
});
