import { beforeEach, expect, jest, test } from "@jest/globals";
import { act, fireEvent, render, screen } from "@testing-library/react-native";
import type { HostSummary } from "../../../../src/remote/hostSummary.ts";
import type { ReadableSummary } from "../../../../src/remote/readableSummary.ts";
import {
  KriyonNative,
  type ScreenFrameEvent,
} from "../../modules/kriyon-native/index.ts";
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
    addListener: jest.fn((_name: string, listener: never) => {
      frameListeners.push(listener);
      return { remove: jest.fn() };
    }),
    compose: jest.fn(() => Promise.resolve()),
    input: jest.fn(() => Promise.resolve()),
    setView: jest.fn(() => Promise.resolve()),
    takeControl: jest.fn(() => Promise.resolve()),
  },
}));

const native = jest.mocked(KriyonNative);
const frameListeners: ((event: ScreenFrameEvent) => void)[] = [];

/** The computer's screen stream sends `frame` for this session. */
async function screenFrame(frame: number[]) {
  await act(() => {
    for (const listener of frameListeners) {
      listener({ frame: new Uint8Array(frame), hostId: MAC, sessionId: "s1" });
    }
  });
}

/** A whole screen, 80 × 24: the frame that proves the question was seen. */
const SCREEN = [1, 0, 80, 0, 24, 0];
const MAC = "ab".repeat(32);
const STILL_WRITING = /^The form sends too early/;
const ENTRY = /^entry-/;
const FIX_IT = /Yes, fix it/;
const YES = /Yes$/;
const TYPING_OFF = /Typing is off/;

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

/** The same session on a computer this phone is a Controller of: it may
 *  type (ADR-0063), and write to Claude unless Claude asks. */
const asController = (needsYou: boolean): HostSummary => {
  const summary = host(needsYou);
  return {
    ...summary,
    role: "controller",
    sessions: summary.sessions.map((one) => ({
      ...one,
      mayCompose: !needsYou,
      mayType: true,
    })),
  };
};

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
  frameListeners.length = 0;
  usePhone.setState(usePhone.getInitialState());
  usePhone.setState({
    screen: { hostId: MAC, kind: "session", sessionId: "s1" },
    states: { [MAC]: host(true) },
  });
});

/** The views asked of Rust, in order, as [open, screen on, entries]. */
function viewsAsked(): [boolean, boolean, boolean][] {
  return native.setView.mock.calls.map(
    ([, , , open, screen, entries]) =>
      [open, screen !== "off", entries] as [boolean, boolean, boolean]
  );
}

test("a session opens on its readable view, which reads its entries", async () => {
  const view = await render(<SessionScreen hostId={MAC} sessionId="s1" />);
  await act(() => Promise.resolve());
  expect(native.setView).toHaveBeenCalledWith(
    MAC,
    "s1",
    expect.any(Number),
    true,
    "off",
    true
  );
  expect(screen.queryByTestId("terminal-page")).toBeNull();
  await view.unmount();
  await act(() => Promise.resolve());
  expect(viewsAsked().at(-1)).toEqual([false, false, false]);
});

test("opened straight on the terminal, the session ends open with its screen on", async () => {
  await render(
    <SessionScreen hostId={MAC} initialView="terminal" sessionId="s1" />
  );
  await act(() => Promise.resolve());
  expect(viewsAsked().at(-1)).toEqual([true, true, true]);
  expect(viewsAsked()).not.toContainEqual([false, false, false]);
});

test("switching to the terminal and back keeps the session open", async () => {
  await render(<SessionScreen hostId={MAC} sessionId="s1" />);
  await act(() => send(CONVERSATION));
  await fireEvent.press(screen.getByRole("tab", { name: "Terminal" }));
  await act(() => Promise.resolve());
  expect(viewsAsked().at(-1)).toEqual([true, true, true]);
  await fireEvent.press(screen.getByRole("tab", { name: "Readable" }));
  await act(() => Promise.resolve());
  expect(viewsAsked().at(-1)).toEqual([true, false, true]);
  // Never closed between.
  expect(viewsAsked().every(([open]) => open)).toBe(true);
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

test("a Controller answers Claude's question by its choices, once its screen has shown it", async () => {
  usePhone.setState({ states: { [MAC]: asController(true) } });
  await render(<SessionScreen hostId={MAC} sessionId="s1" />);
  await act(() => send(CONVERSATION));
  native.setView.mockClear();
  await fireEvent.press(
    screen.getByRole("button", { name: "2. No, leave it" })
  );
  // The computer takes an answer only from a screen that showed the
  // question: the screen comes on first, and the key waits for it.
  expect(viewsAsked().at(-1)).toEqual([true, true, true]);
  expect(native.input).not.toHaveBeenCalled();
  await screenFrame(SCREEN);
  expect(native.input).toHaveBeenLastCalledWith(
    MAC,
    "s1",
    new TextEncoder().encode("2")
  );
  // The computer says it reached the session: answered, screen off again.
  await screenFrame([2, 1]);
  expect(screen.getByText("Answered.")).toBeOnTheScreen();
  expect(viewsAsked().at(-1)).toEqual([true, false, true]);
  expect(
    screen.queryByRole("button", { name: "Answer in the terminal" })
  ).toBeNull();
});

test("a refused answer says why, in the computer's words", async () => {
  usePhone.setState({ states: { [MAC]: asController(true) } });
  await render(<SessionScreen hostId={MAC} sessionId="s1" />);
  await act(() => send(CONVERSATION));
  await fireEvent.press(screen.getByRole("button", { name: "Esc" }));
  await screenFrame(SCREEN);
  expect(native.input).toHaveBeenLastCalledWith(
    MAC,
    "s1",
    new Uint8Array([27])
  );
  await screenFrame([
    3,
    4,
    ...new TextEncoder().encode("That changed: look again."),
  ]);
  expect(screen.getByText("That changed: look again.")).toBeOnTheScreen();
});

test("a Viewer reads the question with no way to answer it", async () => {
  await render(<SessionScreen hostId={MAC} sessionId="s1" />);
  await act(() => send(CONVERSATION));
  expect(screen.getByText(FIX_IT)).toBeOnTheScreen();
  expect(screen.queryByRole("button", { name: FIX_IT })).toBeNull();
  expect(screen.queryByRole("button", { name: "Esc" })).toBeNull();
});

test("a question no longer showing takes no answer", async () => {
  usePhone.setState({ states: { [MAC]: asController(false) } });
  await render(<SessionScreen hostId={MAC} sessionId="s1" />);
  await act(() => send(CONVERSATION));
  expect(screen.getByText(FIX_IT)).toBeOnTheScreen();
  expect(screen.queryByRole("button", { name: "Esc" })).toBeNull();
});

test("in the terminal, the header says how the session stands, never who holds control", async () => {
  usePhone.setState({ states: { [MAC]: asController(false) } });
  await render(
    <SessionScreen hostId={MAC} initialView="terminal" sessionId="s1" />
  );
  expect(screen.getByText("Running")).toBeOnTheScreen();
  expect(screen.queryByText("You're typing")).toBeNull();
});

test("no entries: the terminal, with why; Readable tries again", async () => {
  await render(<SessionScreen hostId={MAC} sessionId="s1" />);
  await act(() =>
    send({ entries: [], unavailable: "The Kriyon Companion is off." })
  );
  expect(screen.getByText("The Kriyon Companion is off.")).toBeOnTheScreen();
  expect(screen.getByTestId("terminal-page")).toBeOnTheScreen();
  native.setView.mockClear();
  await fireEvent.press(screen.getByRole("tab", { name: "Readable" }));
  await act(() => Promise.resolve());
  expect(screen.queryByTestId("terminal-page")).toBeNull();
  // Its entries off, then on: read afresh.
  expect(viewsAsked().map(([, , entries]) => entries)).toContain(false);
  expect(viewsAsked().at(-1)?.[2]).toBe(true);
});

test("what the session needs from you shows on top, in a word", async () => {
  await render(<SessionScreen hostId={MAC} sessionId="s1" />);
  expect(screen.getByText("Asking")).toBeOnTheScreen();
  expect(screen.getByText("Mac")).toBeOnTheScreen();
  await act(() => usePhone.getState().hostChanged(host(false)));
  expect(screen.queryByText("Asking")).toBeNull();
  expect(screen.getByText("Running")).toBeOnTheScreen();
});

test("while Claude asks, the message bar points to its choices", async () => {
  usePhone.setState({ states: { [MAC]: asController(true) } });
  await render(<SessionScreen hostId={MAC} sessionId="s1" />);
  expect(
    screen.getByText("Typing is off while Claude asks. Pick an answer above.")
  ).toBeOnTheScreen();
  expect(screen.getByLabelText("Message").props.editable).toBe(false);
});

test("a session that can't be opened says so on its readable view", async () => {
  native.setView.mockRejectedValueOnce(new Error("not connected"));
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

/** A session this phone controls, the computer saying whether it may compose. */
function controlled(mayCompose: boolean): HostSummary {
  const summary = host(false);
  const [one] = summary.sessions;
  return {
    ...summary,
    role: "controller",
    sessions: one ? [{ ...one, mayCompose, mayType: true, typing: "you" }] : [],
  };
}

test("a message goes to Claude as the computer composes it, when it says this phone may", async () => {
  usePhone.setState({ states: { [MAC]: controlled(true) } });
  await render(<SessionScreen hostId={MAC} sessionId="s1" />);
  await fireEvent.changeText(screen.getByLabelText("Message"), "run the tests");
  await fireEvent.press(screen.getByRole("button", { name: "Send" }));
  expect(native.compose).toHaveBeenCalledWith(MAC, "s1", "run the tests");
});

test("the message bar stays off when the computer says this phone may not compose", async () => {
  usePhone.setState({ states: { [MAC]: controlled(false) } });
  await render(<SessionScreen hostId={MAC} sessionId="s1" />);
  expect(screen.getByLabelText("Message").props.editable).toBe(false);
  expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
});

test("a message the computer refused says why, and the words come back", async () => {
  usePhone.setState({ states: { [MAC]: controlled(true) } });
  native.compose.mockRejectedValueOnce(
    new Error("A question shows: answer it in the terminal.")
  );
  await render(<SessionScreen hostId={MAC} sessionId="s1" />);
  await fireEvent.changeText(screen.getByLabelText("Message"), "hello");
  await fireEvent.press(screen.getByRole("button", { name: "Send" }));
  expect(
    await screen.findByText("A question shows: answer it in the terminal.")
  ).toBeOnTheScreen();
  expect(screen.getByLabelText("Message").props.value).toBe("hello");
});

test("the bar's words follow the computer: none when it says this phone may compose", async () => {
  usePhone.setState({ states: { [MAC]: controlled(true) } });
  await render(<SessionScreen hostId={MAC} sessionId="s1" />);
  // The conversation still ends on a question the computer says is gone.
  await act(() => send(CONVERSATION));
  expect(screen.queryByText(TYPING_OFF)).toBeNull();
  expect(screen.getByLabelText("Message").props.editable).toBe(true);
});
