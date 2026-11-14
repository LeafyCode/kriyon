import { beforeEach, expect, jest, test } from "@jest/globals";
import { act, fireEvent, render, screen } from "@testing-library/react-native";
import type { HostSummary } from "../../../../src/remote/hostSummary.ts";
import type { ReadableSummary } from "../../../../src/remote/readableSummary.ts";
import { KriyonNative } from "../../modules/kriyon-native/index.ts";
import { usePhone } from "../state/phone.ts";
import { SessionScreen } from "./SessionScreen.tsx";

// The terminal's web view is native: a stand-in that says it is there.
jest.mock("react-native-webview", () => {
  const { View } =
    jest.requireActual<typeof import("react-native")>("react-native");
  return { WebView: () => <View testID="terminal-page" /> };
});
jest.mock("../terminal/page.generated.ts", () => ({ TERMINAL_PAGE: "" }));

jest.mock("../../modules/kriyon-native/index.ts", () => ({
  KriyonNative: {
    addListener: jest.fn(() => ({ remove: jest.fn() })),
    closeSession: jest.fn(() => Promise.resolve()),
    openSession: jest.fn(() => Promise.resolve()),
    readEntries: jest.fn(() => Promise.resolve()),
    setScreen: jest.fn(() => Promise.resolve()),
    takeControl: jest.fn(() => Promise.resolve()),
  },
}));

const native = jest.mocked(KriyonNative);
const MAC = "ab".repeat(32);
const STILL_WRITING = /^The form sends too early/;
const ENTRY = /^entry-/;
const FIX_IT = /Yes, fix it/;
const YES = /Yes$/;

const host = (needsYou: boolean): HostSummary => ({
  hostId: MAC,
  hostName: "Mac",
  link: "connected",
  mayStart: false,
  projects: [],
  refused: null,
  role: "viewer",
  sessions: [
    {
      dialogOpen: needsYou,
      id: "s1",
      lastChangeMs: 0,
      mayType: false,
      needsYou,
      projectId: "p",
      standing: needsYou ? "awaiting_input" : "running",
      status: needsYou ? "waiting" : "running",
      title: "Fix the login",
      typing: "host",
    },
  ],
});

const CONVERSATION: ReadableSummary = {
  entries: [
    { kind: "you", seq: 1, text: "Fix the login bug" },
    { done: false, kind: "claude", seq: 2, text: "The form sends too early" },
    {
      kind: "step",
      name: "Read",
      seq: 3,
      state: "done",
      target: "src/login.ts",
    },
    { kind: "step", name: "Bash", seq: 4, state: "failed", target: "npm test" },
    {
      kind: "report",
      outcome: "Finished",
      seq: 5,
      summary: "Waited for the token",
    },
    { kind: "note", seq: 6, text: "Context compacted" },
    {
      header: "Tests",
      kind: "asking",
      options: ["Yes, fix it", "No, leave it"],
      question: "Fix the failing test too?",
      seq: 7,
    },
  ],
  unavailable: null,
};

/** Rust sends the session's entries. */
function send(summary: ReadableSummary) {
  usePhone.getState().entriesChanged({ hostId: MAC, sessionId: "s1", summary });
}

beforeEach(() => {
  jest.clearAllMocks();
  usePhone.setState(usePhone.getInitialState());
  usePhone.setState({
    screen: { hostId: MAC, kind: "session", sessionId: "s1" },
    states: { [MAC]: host(true) },
  });
});

test("a session opens on its readable view, which reads its entries", async () => {
  const view = await render(<SessionScreen hostId={MAC} sessionId="s1" />);
  await act(() => Promise.resolve());
  expect(native.openSession).toHaveBeenCalledWith(MAC, "s1");
  expect(native.readEntries).toHaveBeenCalledWith(MAC, "s1");
  expect(screen.queryByTestId("terminal-page")).toBeNull();
  await view.unmount();
  await act(() => Promise.resolve());
  expect(native.closeSession).toHaveBeenCalledWith(MAC, "s1");
});

test("opened straight on the terminal, the session opens before its screen comes on", async () => {
  await render(
    <SessionScreen hostId={MAC} initialView="terminal" sessionId="s1" />
  );
  await act(() => Promise.resolve());
  await act(() => Promise.resolve());
  expect(native.openSession).toHaveBeenCalledWith(MAC, "s1");
  expect(native.setScreen).toHaveBeenCalledWith(MAC, "s1", true);
  expect(native.openSession.mock.invocationCallOrder[0]).toBeLessThan(
    native.setScreen.mock.invocationCallOrder[0] ?? 0
  );
});

test("switching to the terminal and back keeps the session open", async () => {
  await render(<SessionScreen hostId={MAC} sessionId="s1" />);
  await act(() => send(CONVERSATION));
  await fireEvent.press(screen.getByRole("tab", { name: "Terminal" }));
  await act(() => Promise.resolve());
  expect(native.setScreen).toHaveBeenLastCalledWith(MAC, "s1", true);
  await fireEvent.press(screen.getByRole("tab", { name: "Readable" }));
  await act(() => Promise.resolve());
  expect(native.setScreen).toHaveBeenLastCalledWith(MAC, "s1", false);
  expect(native.openSession).toHaveBeenCalledTimes(1);
  expect(native.closeSession).not.toHaveBeenCalled();
  // What it read is still there.
  expect(screen.queryByTestId("terminal-page")).toBeNull();
});

test("the entries show in order, a Viewer's too", async () => {
  await render(<SessionScreen hostId={MAC} sessionId="s1" />);
  await act(() => send(CONVERSATION));
  const texts = [
    "Fix the login bug",
    // Still being written: a caret follows.
    STILL_WRITING,
    "src/login.ts",
    "npm test",
    "Waited for the token",
    "Context compacted",
    "Fix the failing test too?",
  ];
  for (const text of texts) {
    expect(screen.getByText(text)).toBeOnTheScreen();
  }
  const shown = screen
    .getAllByTestId(ENTRY)
    .map((node) => node.props.testID as string);
  expect(shown).toEqual([1, 2, 3, 4, 5, 6, 7].map((seq) => `entry-${seq}`));
  expect(screen.getByText("Finished")).toBeOnTheScreen();
});

test("Claude's growing reply changes in place", async () => {
  await render(<SessionScreen hostId={MAC} sessionId="s1" />);
  await act(() => send(CONVERSATION));
  await act(() =>
    send({
      ...CONVERSATION,
      entries: CONVERSATION.entries.map((entry) =>
        entry.kind === "claude"
          ? { ...entry, done: true, text: "The form sends too early, fixed." }
          : entry
      ),
    })
  );
  expect(
    screen.getByText("The form sends too early, fixed.")
  ).toBeOnTheScreen();
  expect(screen.queryByText("The form sends too early")).toBeNull();
  expect(screen.getAllByTestId("entry-2")).toHaveLength(1);
});

test("a question is answered only in the terminal", async () => {
  await render(<SessionScreen hostId={MAC} sessionId="s1" />);
  await act(() => send(CONVERSATION));
  expect(screen.getByText(FIX_IT)).toBeOnTheScreen();
  expect(screen.queryByRole("button", { name: FIX_IT })).toBeNull();
  await fireEvent.press(
    screen.getByRole("button", { name: "Answer in the terminal" })
  );
  expect(screen.getByTestId("terminal-page")).toBeOnTheScreen();
});

test("no entries: the terminal, with why; Readable tries again", async () => {
  await render(<SessionScreen hostId={MAC} sessionId="s1" />);
  await act(() =>
    send({ entries: [], unavailable: "The Kriyon Companion is off." })
  );
  expect(screen.getByText("The Kriyon Companion is off.")).toBeOnTheScreen();
  expect(screen.getByTestId("terminal-page")).toBeOnTheScreen();
  native.readEntries.mockClear();
  await fireEvent.press(screen.getByRole("tab", { name: "Readable" }));
  await act(() => Promise.resolve());
  expect(screen.queryByTestId("terminal-page")).toBeNull();
  expect(native.readEntries).toHaveBeenCalledWith(MAC, "s1");
});

test("what the session needs from you shows on top, in a word", async () => {
  await render(<SessionScreen hostId={MAC} sessionId="s1" />);
  expect(screen.getByText("Asking")).toBeOnTheScreen();
  expect(screen.getByText("Mac")).toBeOnTheScreen();
  await act(() => usePhone.getState().hostChanged(host(false)));
  expect(screen.queryByText("Asking")).toBeNull();
  expect(screen.getByText("Running")).toBeOnTheScreen();
});

test("while Claude asks, the message bar says to answer in the terminal", async () => {
  await render(<SessionScreen hostId={MAC} sessionId="s1" />);
  expect(
    screen.getByText("Typing is off while Claude asks. Answer in the terminal.")
  ).toBeOnTheScreen();
  expect(screen.getByLabelText("Message").props.editable).toBe(false);
});

test("a session that can't be opened says so on its readable view", async () => {
  native.openSession.mockRejectedValueOnce(new Error("not connected"));
  await render(<SessionScreen hostId={MAC} sessionId="s1" />);
  expect(await screen.findByText("not connected")).toBeOnTheScreen();
  expect(screen.queryByTestId("terminal-page")).toBeNull();
});

test("showing the session again keeps what it reads", async () => {
  await render(<SessionScreen hostId={MAC} sessionId="s1" />);
  await act(() => send(CONVERSATION));
  await act(() =>
    usePhone.getState().show({ hostId: MAC, kind: "session", sessionId: "s1" })
  );
  expect(screen.getByText("Fix the login bug")).toBeOnTheScreen();
});

test("leaving a session with no entries, then coming back, reads afresh", async () => {
  const first = await render(<SessionScreen hostId={MAC} sessionId="s1" />);
  await act(() => send({ entries: [], unavailable: "off" }));
  expect(screen.getByTestId("terminal-page")).toBeOnTheScreen();
  await first.unmount();
  await render(<SessionScreen hostId={MAC} sessionId="s1" />);
  expect(screen.queryByTestId("terminal-page")).toBeNull();
});

test("two options with the same words both show", async () => {
  await render(<SessionScreen hostId={MAC} sessionId="s1" />);
  await act(() =>
    send({
      entries: [
        {
          header: "",
          kind: "asking",
          options: ["Yes", "Yes"],
          question: "Sure?",
          seq: 1,
        },
      ],
      unavailable: null,
    })
  );
  expect(screen.getAllByText(YES)).toHaveLength(2);
});
