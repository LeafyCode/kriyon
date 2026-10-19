import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { CommandCatalog } from "../ipc/bridge.ts";
import { promptHistory, submitPrompt, writeStdin } from "../ipc/bridge.ts";
import { useAttachments } from "../state/attachments.ts";
import { useCompletions } from "../state/completions.ts";
import { useDrafts } from "../state/drafts.ts";
import { DEFAULT_LAYOUT, useLayout } from "../state/layout.ts";
import { useSentPrompts } from "../state/sentPrompts.ts";
import { useSessions } from "../state/sessions.ts";
import { useUi } from "../state/ui.ts";
import { useUsageCards } from "../state/usageCards.ts";
import { PromptBar } from "./PromptBar.tsx";

vi.mock("../ipc/bridge", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../ipc/bridge.ts")>()),
  listFiles: vi.fn().mockResolvedValue([]),
  promptHistory: vi.fn().mockResolvedValue([]),
  structuredTurns: vi.fn().mockResolvedValue([]),
  submitPrompt: vi.fn(),
  writeStdin: vi.fn(),
}));

const mockedWriteStdin = vi.mocked(writeStdin);
const mockedSubmit = vi.mocked(submitPrompt);

function resetStore(): void {
  useSessions.setState({
    activeSessionId: null,
    activity: {},
    events: {},
    projects: [],
    sessions: {},
    usage: {},
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedWriteStdin.mockResolvedValue(undefined);
  mockedSubmit.mockResolvedValue(undefined);
  useAttachments.setState({ bySession: {} });
  useSentPrompts.setState({ sent: {} });
  resetStore();
  useDrafts.setState({ drafts: {}, insertRequest: null });
  useCompletions.setState({ byCwd: {}, loading: {} });
  const state = useSessions.getState();
  state.addSession({
    archivedAt: null,
    baselineOid: null,
    claudeSessionId: null,
    createdAt: 1,
    cwd: "",
    id: "s1",
    projectId: "p1",
    status: "idle",
    summary: "",
    title: "s1",
    titleLocked: false,
    worktreePath: null,
  });
  state.setActiveSession("s1");
  useUi.setState({ promptEditorSeed: null, promptPickerOpen: false });
  useLayout.setState({ layout: DEFAULT_LAYOUT });
  useUsageCards.setState({ shown: {} });
});

afterEach(() => {
  vi.useRealTimers();
});

const enc = (s: string) => new TextEncoder().encode(s);

/**
 * Simulate typing `text` into the (uncontrolled) chip editor: jsdom doesn't
 * actually drive contentEditable keystrokes, so this sets the DOM content
 * directly, places a collapsed selection at its end (so `syncFromDom` inside
 * `handleInput` picks up a real caret), then fires the same `input` event a
 * real keystroke would.
 */
function typeInto(el: HTMLElement, text: string): void {
  el.textContent = text;
  const sel = window.getSelection();
  const range = document.createRange();
  const textNode = el.firstChild;
  if (textNode) {
    range.setStart(textNode, text.length);
    range.setEnd(textNode, text.length);
  } else {
    range.selectNodeContents(el);
  }
  sel?.removeAllRanges();
  sel?.addRange(range);
  fireEvent.input(el);
}

/** Place a collapsed selection at (node, offset) and fire the keyup jsdom
 * would follow a real caret move with, so `syncFromDom` re-reads it. */
function placeCaretAt(el: HTMLElement, node: Node, offset: number): void {
  const sel = window.getSelection();
  const range = document.createRange();
  range.setStart(node, offset);
  range.setEnd(node, offset);
  sel?.removeAllRanges();
  sel?.addRange(range);
  fireEvent.keyUp(el, { key: "ArrowRight" });
}

test("send hands the message and its attachments to the backend to type", () => {
  useAttachments.getState().add("s1", [
    {
      bytes: 1,
      caution: null,
      convertedFrom: null,
      kind: "image",
      name: "a.png",
      path: "/a.png",
    },
  ]);
  render(<PromptBar />);

  const editable = screen.getByLabelText("Message the session");
  typeInto(editable, "hello world");
  fireEvent.keyDown(editable, { key: "Enter" });

  expect(mockedSubmit).toHaveBeenCalledWith("s1", "hello world", ["/a.png"]);
  expect(useAttachments.getState().bySession.s1).toBeUndefined();
  expect(useSentPrompts.getState().sent.s1?.attachments).toHaveLength(1);
});

test("send waits while Claude Code shows a dialog: Enter there would pick an option", () => {
  useSessions.setState({
    activity: {
      s1: {
        main: { currentTool: null },
        pendingAsk: { askedAt: null, kind: "question", text: "Which db?" },
        shells: [],
        subagents: [],
        tasks: [],
      },
    },
  });
  render(<PromptBar />);

  const editable = screen.getByLabelText("Message the session");
  typeInto(editable, "hello world");
  fireEvent.keyDown(editable, { key: "Enter" });

  expect(mockedSubmit).not.toHaveBeenCalled();
  expect(useDrafts.getState().drafts.s1).toBe("hello world");
});

test("/usage in the Structured view opens Kriyon's usage card instead of Claude's pane", () => {
  useLayout.setState({
    layout: { ...DEFAULT_LAYOUT, transcriptView: "structured" },
  });
  render(<PromptBar />);
  const editable = screen.getByLabelText("Message the session");
  typeInto(editable, "/usage");
  fireEvent.keyDown(editable, { key: "Enter" });

  expect(mockedSubmit).not.toHaveBeenCalled();
  expect(useSentPrompts.getState().sent.s1).toBeUndefined();
  expect(useUsageCards.getState().shown.s1?.command).toBe("/usage");
  expect(useDrafts.getState().drafts.s1).toBe("");
});

test("/usage in the Raw view goes to Claude, as typed", () => {
  render(<PromptBar />);
  const editable = screen.getByLabelText("Message the session");
  typeInto(editable, "/usage");
  fireEvent.keyDown(editable, { key: "Enter" });

  expect(mockedSubmit).toHaveBeenCalledWith("s1", "/usage", []);
  expect(useUsageCards.getState().shown.s1).toBeUndefined();
});

test("an image alone can be sent", () => {
  useAttachments.getState().add("s1", [
    {
      bytes: 1,
      caution: null,
      convertedFrom: null,
      kind: "image",
      name: "a.png",
      path: "/a.png",
    },
  ]);
  render(<PromptBar />);
  fireEvent.click(screen.getByRole("button", { name: "Send ↵" }));
  expect(mockedSubmit).toHaveBeenCalledWith("s1", "", ["/a.png"]);
});

test("Esc while Claude works stops it, and Stop does the same", () => {
  useSessions.setState((state) => ({
    sessions: {
      ...state.sessions,
      s1: { ...state.sessions.s1, status: "running" },
    },
  }));
  render(<PromptBar />);
  const editable = screen.getByLabelText("Message the session");
  fireEvent.keyDown(editable, { key: "Escape" });
  expect(mockedWriteStdin).toHaveBeenCalledWith("s1", enc("\u001b"));
  expect(screen.getByRole("button", { name: "Stop Claude" })).toBeTruthy();
});

test("Esc with nothing running is left alone", () => {
  render(<PromptBar />);
  fireEvent.keyDown(screen.getByLabelText("Message the session"), {
    key: "Escape",
  });
  expect(mockedWriteStdin).not.toHaveBeenCalled();
  expect(screen.queryByRole("button", { name: "Stop Claude" })).toBeNull();
});

test("send remembers the prompt so the Structured view can show it at once", () => {
  useSentPrompts.setState({ sent: {} });
  render(<PromptBar />);
  const editable = screen.getByLabelText("Message the session");
  typeInto(editable, "hello world");
  fireEvent.keyDown(editable, { key: "Enter" });
  expect(useSentPrompts.getState().sent.s1?.text).toBe("hello world");
});

test("send leaves the caret inside the composer instead of orphaning it", () => {
  vi.useFakeTimers();
  render(<PromptBar />);

  const editable = screen.getByLabelText("Message the session");
  editable.focus();
  typeInto(editable, "hello world");
  fireEvent.keyDown(editable, { key: "Enter" });

  // Clearing the editable destroys the node the caret was anchored to. Left
  // orphaned, WebKit re-anchors the collapsed selection outside the editable,
  // and a caret out there costs a whole-document word scan on every rendering
  // update — the freeze `ui/strayCaret.ts` documents. jsdom's own node-removal
  // rules happen to collapse the range back into the editable, so this locks
  // the invariant rather than reproducing WebKit's divergence.
  const selection = window.getSelection();
  expect(selection?.rangeCount).toBe(1);
  expect(editable.contains(selection?.anchorNode ?? null)).toBe(true);
});

test("send leaves a selection made outside the composer where the user put it", () => {
  vi.useFakeTimers();
  render(<PromptBar />);

  const editable = screen.getByLabelText("Message the session");
  typeInto(editable, "hello world");

  // The user selects a diff line, then sends. Restoring the composer's caret
  // must not reach out and take a selection that was never the composer's.
  const elsewhere = document.createElement("p");
  elsewhere.textContent = "a diff line";
  document.body.append(elsewhere);
  const range = document.createRange();
  range.selectNodeContents(elsewhere);
  window.getSelection()?.removeAllRanges();
  window.getSelection()?.addRange(range);
  editable.blur();

  fireEvent.keyDown(editable, { key: "Enter" });

  expect(window.getSelection()?.anchorNode).toBe(elsewhere);
  elsewhere.remove();
});

test("does not send when the input is only whitespace", () => {
  vi.useFakeTimers();
  render(<PromptBar />);

  const editable = screen.getByLabelText("Message the session");
  typeInto(editable, "   ");
  fireEvent.keyDown(editable, { key: "Enter" });

  vi.advanceTimersByTime(1000);
  expect(mockedSubmit).not.toHaveBeenCalled();
});

test("Shift+Enter does not submit", () => {
  vi.useFakeTimers();
  render(<PromptBar />);

  const editable = screen.getByLabelText("Message the session");
  typeInto(editable, "line one");
  fireEvent.keyDown(editable, { key: "Enter", shiftKey: true });

  vi.advanceTimersByTime(1000);
  expect(mockedSubmit).not.toHaveBeenCalled();
});

// A CJK/IME user confirms a candidate with Enter; WebKit still reports that
// keydown as key "Enter" but with isComposing=true. It must commit the
// composition, not submit a half-composed message to the PTY.
test("Enter that confirms an IME composition does not submit", () => {
  vi.useFakeTimers();
  render(<PromptBar />);

  const editable = screen.getByLabelText("Message the session");
  typeInto(editable, "にほんご");
  fireEvent.keyDown(editable, { key: "Enter", isComposing: true });

  vi.advanceTimersByTime(1000);
  expect(mockedSubmit).not.toHaveBeenCalled();

  // Once composition ends, the next Enter submits normally.
  fireEvent.compositionEnd(editable);
  fireEvent.keyDown(editable, { key: "Enter" });
  expect(mockedSubmit).toHaveBeenCalledTimes(1);
  expect(mockedSubmit).toHaveBeenLastCalledWith("s1", "にほんご", []);
});

test("renders the active session's draft into the editable", () => {
  useDrafts.getState().setDraft("s1", "saved text");
  render(<PromptBar />);
  expect(screen.getByLabelText("Message the session")).toHaveTextContent(
    "saved text"
  );
});

test("consumes an insert request into the draft and clears it", async () => {
  render(<PromptBar />);
  const editable = screen.getByLabelText("Message the session");
  typeInto(editable, "before ");
  useDrafts.getState().requestInsert("s1", "INSERTED");
  await vi.waitFor(() => {
    expect(useDrafts.getState().drafts.s1).toContain("INSERTED");
  });
  expect(useDrafts.getState().insertRequest).toBeNull();
});

test("drops a stale insert request targeting a non-active session", async () => {
  render(<PromptBar />);
  useDrafts.getState().requestInsert("not-s1", "STALE");

  await vi.waitFor(() => {
    expect(useDrafts.getState().insertRequest).toBeNull();
  });
  expect(useDrafts.getState().drafts.s1 ?? "").toBe("");
});

test("keeps separate drafts per session when switching", () => {
  useSessions.getState().addSession({
    archivedAt: null,
    baselineOid: null,
    claudeSessionId: null,
    createdAt: 2,
    cwd: "",
    id: "s2",
    projectId: "p1",
    status: "idle",
    summary: "",
    title: "s2",
    titleLocked: false,
    worktreePath: null,
  });
  useDrafts.getState().setDraft("s1", "one");
  useDrafts.getState().setDraft("s2", "two");
  render(<PromptBar />);
  act(() => {
    useSessions.getState().setActiveSession("s2");
  });
  expect(screen.getByLabelText("Message the session")).toHaveTextContent("two");
});

test("the Prompts button opens the picker and shows the ⌘⇧P shortcut", () => {
  render(<PromptBar />);
  const btn = screen.getByRole("button", { name: "Open prompt library" });
  expect(btn).toHaveTextContent("⌘⇧P");
  fireEvent.click(btn);
  expect(useUi.getState().promptPickerOpen).toBe(true);
});

test("Save prompt seeds the editor from the current draft", () => {
  useDrafts.setState({
    drafts: { s1: "Refactor the auth module\nsecond line" },
  });
  render(<PromptBar />);
  fireEvent.click(screen.getByRole("button", { name: "Save as prompt" }));
  const seed = useUi.getState().promptEditorSeed;
  expect(seed).toEqual({
    body: "Refactor the auth module\nsecond line",
    tags: [],
    title: "Refactor the auth module",
  });
  expect(seed?.id).toBeUndefined();
});

test("Save prompt is disabled and inert when the draft is empty", () => {
  useDrafts.setState({ drafts: { s1: "   " } });
  render(<PromptBar />);
  const btn = screen.getByRole("button", { name: "Save as prompt" });
  expect(btn).toBeDisabled();
  fireEvent.click(btn);
  expect(useUi.getState().promptEditorSeed).toBeNull();
});

test("the composer hides to a slim reveal strip and comes back", () => {
  render(<PromptBar />);

  fireEvent.click(screen.getByRole("button", { name: "Hide composer" }));

  expect(useLayout.getState().layout.composerCollapsed).toBe(true);
  // The composer stays mounted (drafts survive) but is collapsed shut and
  // taken out of the accessibility tree.
  const drawer = screen.getByTestId("composer-drawer");
  expect(drawer.style.gridTemplateRows).toBe("0fr");
  expect(drawer).toHaveAttribute("aria-hidden", "true");

  fireEvent.click(screen.getByRole("button", { name: "Show composer" }));

  expect(useLayout.getState().layout.composerCollapsed).toBe(false);
  expect(drawer.style.gridTemplateRows).toBe("1fr");
  expect(
    screen.queryByRole("button", { name: "Show composer" })
  ).not.toBeInTheDocument();
});

test("a prompt insert reveals a hidden composer instead of splicing invisibly", async () => {
  useLayout.getState().toggleComposerCollapsed();
  render(<PromptBar />);

  // The ⌘⇧P picker works from anywhere — inserting while hidden must bring
  // the composer back so the user sees what just landed in the draft.
  act(() => {
    useDrafts.getState().requestInsert("s1", "review the diff");
  });

  await waitFor(() => {
    expect(useLayout.getState().layout.composerCollapsed).toBe(false);
    expect(screen.getByLabelText("Message the session")).toHaveTextContent(
      "review the diff"
    );
  });
});

test("hiding moves focus to the reveal strip; showing focuses the editable", () => {
  render(<PromptBar />);

  fireEvent.click(screen.getByRole("button", { name: "Hide composer" }));
  expect(screen.getByRole("button", { name: "Show composer" })).toHaveFocus();

  fireEvent.click(screen.getByRole("button", { name: "Show composer" }));
  expect(screen.getByLabelText("Message the session")).toHaveFocus();
});

test("clicking the composer's padding focuses the editable, not nothing", () => {
  render(<PromptBar />);
  const editable = screen.getByLabelText("Message the session");
  // The rounded box is what reads as "the input"; the editable is a 24px line
  // inside its 14px padding. A press on the padding must land in the editor.
  const box = editable.parentElement?.parentElement as HTMLElement;

  // fireEvent returns false when the handler called preventDefault — the line
  // that stops the press collapsing the selection onto the box itself.
  expect(fireEvent.mouseDown(box, { button: 0 })).toBe(false);

  expect(editable).toHaveFocus();
});

test("a press inside the editable is left to the browser, caret where you clicked", () => {
  useDrafts.setState({ drafts: { s1: "half-typed thought" } });
  render(<PromptBar />);
  const editable = screen.getByLabelText("Message the session");
  const text = editable.firstChild as Node;
  placeCaretAt(editable, text, 4);

  // Not defaultPrevented, and the caret stays where the browser put it rather
  // than being yanked to the end of the draft.
  expect(fireEvent.mouseDown(editable, { button: 0 })).toBe(true);
  expect(window.getSelection()?.focusOffset).toBe(4);
});

test("clicking the composer's padding puts the caret at the end of the draft", () => {
  useDrafts.setState({ drafts: { s1: "half-typed thought" } });
  render(<PromptBar />);
  const editable = screen.getByLabelText("Message the session");
  const box = editable.parentElement?.parentElement as HTMLElement;

  expect(fireEvent.mouseDown(box, { button: 0 })).toBe(false);

  const selection = window.getSelection();
  expect(selection?.isCollapsed).toBe(true);
  expect(selection?.focusOffset).toBe("half-typed thought".length);
});

test("a press on a footer control is left alone, not hijacked by the composer", () => {
  render(<PromptBar />);
  const editable = screen.getByLabelText("Message the session");
  const prompts = screen.getByRole("button", { name: "Open prompt library" });

  expect(fireEvent.mouseDown(prompts, { button: 0 })).toBe(true);

  expect(editable).not.toHaveFocus();
  fireEvent.click(prompts);
  expect(useUi.getState().promptPickerOpen).toBe(true);
});

test("a right-click in the composer's padding does not seize focus", () => {
  render(<PromptBar />);
  const editable = screen.getByLabelText("Message the session");
  const box = editable.parentElement?.parentElement as HTMLElement;

  expect(fireEvent.mouseDown(box, { button: 2 })).toBe(true);

  expect(editable).not.toHaveFocus();
});

test("a hidden composer keeps its draft for when it returns", () => {
  useDrafts.setState({ drafts: { s1: "half-typed thought" } });
  useLayout.getState().toggleComposerCollapsed();
  render(<PromptBar />);

  fireEvent.click(screen.getByRole("button", { name: "Show composer" }));

  expect(screen.getByLabelText("Message the session")).toHaveTextContent(
    "half-typed thought"
  );
});

const catalog: CommandCatalog = {
  agents: ["Explore"],
  claudeVersion: "x",
  commands: [
    {
      argumentHint: null,
      description: "Clear history",
      name: "clear",
      source: "builtin",
    },
  ],
  degraded: false,
};

function renderWithCompletionsSession(): HTMLElement {
  const state = useSessions.getState();
  state.addSession({
    archivedAt: null,
    baselineOid: null,
    claudeSessionId: null,
    createdAt: 2,
    cwd: "/repo",
    id: "s-completions",
    projectId: "p1",
    status: "idle",
    summary: "",
    title: "s-completions",
    titleLocked: false,
    worktreePath: null,
  });
  state.setActiveSession("s-completions");
  useCompletions.setState({ byCwd: { "/repo": catalog }, loading: {} });

  render(<PromptBar />);
  return screen.getByLabelText("Message the session");
}

test("opens the slash popover and Enter accepts as a chip, not a send", () => {
  const editable = renderWithCompletionsSession();
  typeInto(editable, "/cl");
  fireEvent.keyDown(editable, { key: "ArrowDown" });
  fireEvent.keyDown(editable, { key: "Enter" });

  const chip = editable.querySelector('[data-chip][data-kind="command"]');
  expect(chip).toHaveTextContent("/clear");
  expect(useDrafts.getState().drafts["s-completions"]).toBe("/clear ");
  expect(mockedSubmit).not.toHaveBeenCalled();
});

// The completion popover renders through a portal into document.body, but it
// is still a React child of the composer box — so React bubbles its row clicks
// to the box's handlers even though the DOM says they happened elsewhere.
// The box's "caret to the end of the draft" path must not run there: it fires
// after the row has already spliced its chip in and placed the caret, and
// resets the caret to the pre-accept offset — which lands back inside the
// token and re-opens the popover, exactly the bug the keyboard path fixed.
test("clicking a completion row accepts it without the box resetting the caret", () => {
  const editable = renderWithCompletionsSession();
  typeInto(editable, "/cl");
  const focusSpy = vi.spyOn(editable, "focus");

  fireEvent.mouseDown(screen.getAllByRole("option")[0], { button: 0 });

  // `accept` focuses the editor once and places the caret after the new chip.
  // A second focus means the box handler also ran and re-placed the caret at
  // the stale pre-accept offset.
  expect(focusSpy).toHaveBeenCalledTimes(1);
  expect(editable.querySelector("[data-chip]")).toHaveTextContent("/clear");
});

test("accepting an @agent- mention builds an agent chip", () => {
  const editable = renderWithCompletionsSession();
  typeInto(editable, "@Ex");
  fireEvent.keyDown(editable, { key: "ArrowDown" });
  fireEvent.keyDown(editable, { key: "Enter" });

  const chip = editable.querySelector('[data-chip][data-kind="agent"]');
  expect(chip).toHaveTextContent("@agent-Explore");
});

// Regression: a completion insert with no trailing space (e.g. a no-arg slash
// command) left the caret right after the token, so the very next render
// re-parsed it as a live trigger and the popover reopened — swallowing the
// user's next Enter as another "accept" instead of a submit.
test("closes the popover after accepting, and a follow-up Enter submits", () => {
  vi.useFakeTimers();
  const editable = renderWithCompletionsSession();
  typeInto(editable, "/cl");
  fireEvent.keyDown(editable, { key: "ArrowDown" });
  fireEvent.keyDown(editable, { key: "Enter" });

  expect(useDrafts.getState().drafts["s-completions"]).toBe("/clear ");
  expect(screen.queryByRole("listbox")).not.toBeInTheDocument();

  fireEvent.keyDown(editable, { key: "Enter" });
  vi.advanceTimersByTime(1000);

  expect(mockedSubmit).toHaveBeenCalled();
});

test("renders a data-kind=command chip for a leading slash command in the draft", () => {
  useDrafts.setState({ drafts: { s1: "/compact free up" } });
  render(<PromptBar />);

  const editable = screen.getByLabelText("Message the session");
  const chip = editable.querySelector('[data-chip][data-kind="command"]');
  expect(chip).toHaveTextContent("/compact");
  expect(editable).toHaveTextContent("/compact free up");
});

test("renders a data-kind=agent chip for an @agent- mention in the draft", () => {
  useDrafts.setState({
    drafts: { s1: "ping @agent-Explore now" },
  });
  render(<PromptBar />);

  const editable = screen.getByLabelText("Message the session");
  const chip = editable.querySelector('[data-chip][data-kind="agent"]');
  expect(chip).toHaveTextContent("@agent-Explore");
});

test("renders no chip for plain text", () => {
  useDrafts.setState({ drafts: { s1: "hello" } });
  render(<PromptBar />);

  const editable = screen.getByLabelText("Message the session");
  expect(editable.querySelector("[data-chip]")).toBeNull();
  expect(editable).toHaveTextContent("hello");
});

test("a leading '!' converts live into a bash mode chip as soon as it's typed", () => {
  render(<PromptBar />);
  const editable = screen.getByLabelText("Message the session");

  typeInto(editable, "! ls -la");

  const chip = editable.querySelector('[data-chip][data-kind="bash"]');
  expect(chip).toHaveTextContent("!");
  expect(editable.firstChild).toBe(chip);
  expect(editable).toHaveTextContent("! ls -la");
  expect(useDrafts.getState().drafts.s1).toBe("! ls -la");
});

test("a leading '#' converts live into a memory mode chip", () => {
  render(<PromptBar />);
  const editable = screen.getByLabelText("Message the session");

  typeInto(editable, "#remember this");

  const chip = editable.querySelector('[data-chip][data-kind="memory"]');
  expect(chip).toHaveTextContent("#");
  expect(useDrafts.getState().drafts.s1).toBe("#remember this");
});

test("Backspace right after the mode chip deletes it and exits the mode", () => {
  render(<PromptBar />);
  const editable = screen.getByLabelText("Message the session");
  typeInto(editable, "!ls");

  const [, trailing] = editable.childNodes;
  placeCaretAt(editable, trailing, 0);
  fireEvent.keyDown(editable, { key: "Backspace" });

  expect(editable.querySelector("[data-chip]")).toBeNull();
  expect(useDrafts.getState().drafts.s1).toBe("ls");
});

test("Backspace right after a chip deletes it whole", () => {
  useDrafts.setState({ drafts: { s1: "/compact free up" } });
  render(<PromptBar />);
  const editable = screen.getByLabelText("Message the session");

  // Place the caret at the very start of the trailing text node — i.e. right
  // after the chip — then Backspace.
  const [, trailing] = editable.childNodes;
  placeCaretAt(editable, trailing, 0);
  fireEvent.keyDown(editable, { key: "Backspace" });

  expect(editable.querySelector("[data-chip]")).toBeNull();
  expect(useDrafts.getState().drafts.s1).toBe(" free up");
});

// The composer now mounts on every trip back from the Changes tab, and its
// mount effect re-places the caret. Ungated that reaches out and takes whatever
// selection the user had — in WebKit, taking it destroys the caret it took.
test("mounting does not seize a selection the composer does not own", () => {
  const elsewhere = document.createElement("p");
  elsewhere.textContent = "a diff line";
  document.body.append(elsewhere);
  const range = document.createRange();
  range.selectNodeContents(elsewhere);
  window.getSelection()?.removeAllRanges();
  window.getSelection()?.addRange(range);

  render(<PromptBar />);

  expect(window.getSelection()?.anchorNode).toBe(elsewhere);
  elsewhere.remove();
});

test("unmounting does not leave a caret behind in a detached editor", () => {
  const { unmount } = render(<PromptBar />);
  const editable = screen.getByLabelText("Message the session");
  editable.focus();
  const range = document.createRange();
  range.selectNodeContents(editable);
  window.getSelection()?.removeAllRanges();
  window.getSelection()?.addRange(range);

  unmount();

  expect(window.getSelection()?.rangeCount).toBe(0);
});

test("text pastes as plain text with its newlines kept", () => {
  render(<PromptBar />);
  const editable = screen.getByLabelText("Message the session");
  typeInto(editable, "a ");
  fireEvent.paste(editable, {
    clipboardData: {
      files: [],
      getData: () => "line one\nline two",
      types: ["text/plain", "text/html"],
    },
  });
  expect(useDrafts.getState().drafts.s1).toBe("a line one\nline two");
});

test("Up and Down walk the folder's prompt history, then give the draft back", async () => {
  vi.mocked(promptHistory).mockResolvedValue(["fix the build", "add tests"]);
  useSessions.setState((state) => ({
    sessions: { ...state.sessions, s1: { ...state.sessions.s1, cwd: "/proj" } },
  }));
  render(<PromptBar />);
  await waitFor(() => expect(promptHistory).toHaveBeenCalledWith("/proj"));
  await act(async () => {
    await Promise.resolve();
  });
  const editable = screen.getByLabelText("Message the session");
  typeInto(editable, "half typed");
  fireEvent.keyDown(editable, { key: "ArrowUp" });
  expect(useDrafts.getState().drafts.s1).toBe("fix the build");
  fireEvent.keyDown(editable, { key: "ArrowUp" });
  expect(useDrafts.getState().drafts.s1).toBe("add tests");
  fireEvent.keyDown(editable, { key: "ArrowDown" });
  fireEvent.keyDown(editable, { key: "ArrowDown" });
  expect(useDrafts.getState().drafts.s1).toBe("half typed");
});

/**
 * Lay the footer's tools out as jsdom can't: each character 8px wide, in a
 * box `room` px wide.
 */
function layOutTools(room: number): () => void {
  const isTools = (el: HTMLElement) => el.dataset.testid === "footer-tools";
  const scroll = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    "scrollWidth"
  );
  const client = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    "clientWidth"
  );
  Object.defineProperty(HTMLElement.prototype, "scrollWidth", {
    configurable: true,
    get(this: HTMLElement) {
      return isTools(this) ? (this.textContent ?? "").length * 8 : 0;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "clientWidth", {
    configurable: true,
    get(this: HTMLElement) {
      return isTools(this) ? room : 0;
    },
  });
  return () => {
    if (scroll) {
      Object.defineProperty(HTMLElement.prototype, "scrollWidth", scroll);
    }
    if (client) {
      Object.defineProperty(HTMLElement.prototype, "clientWidth", client);
    }
  };
}

test("a narrow composer gives up its spare parts until its tools fit", () => {
  const restore = layOutTools(120);
  try {
    render(<PromptBar />);
    expect(screen.queryByText("⌘⇧P")).toBeNull();
    expect(screen.queryByText("Session")).toBeNull();
    expect(screen.getByLabelText("Save as prompt").textContent).toBe("✦");
    // "✦" and "Prompts" fit in 120px, so Prompts keeps its label.
    expect(screen.getByLabelText("Open prompt library").textContent).toBe(
      "Prompts"
    );
    expect(screen.getByText("Send ↵")).toBeTruthy();
  } finally {
    restore();
  }
});

test("a very narrow composer turns Prompts into its icon", () => {
  const restore = layOutTools(20);
  try {
    render(<PromptBar />);
    const prompts = screen.getByLabelText("Open prompt library");
    expect(prompts.textContent).toBe("");
    expect(prompts.querySelector("svg")).not.toBeNull();
  } finally {
    restore();
  }
});
