import { beforeEach, expect, jest, test } from "@jest/globals";
import { act, fireEvent, render, screen } from "@testing-library/react-native";
import type { HostSummary } from "../../../../src/remote/hostSummary.ts";
import {
  KriyonNative,
  type ScreenFrameEvent,
} from "../../modules/kriyon-native/index.ts";
import { usePhone } from "../state/phone.ts";
import { TerminalView } from "./TerminalView.tsx";

const injected: string[] = [];
let pageProps: {
  onMessage: (event: { nativeEvent: { data: string } }) => void;
};

jest.mock("react-native-webview", () => {
  const React = jest.requireActual<typeof import("react")>("react");
  const { View } =
    jest.requireActual<typeof import("react-native")>("react-native");
  return {
    WebView: React.forwardRef((props: typeof pageProps, ref) => {
      pageProps = props;
      React.useImperativeHandle(ref, () => ({
        injectJavaScript: (code: string) => injected.push(code),
      }));
      return <View testID="terminal-page" />;
    }),
  };
});

jest.mock("../terminal/page.generated.ts", () => ({
  TERMINAL_PAGE: "<html/>",
}));

const frameListeners: ((event: ScreenFrameEvent) => void)[] = [];

jest.mock("../../modules/kriyon-native/index.ts", () => ({
  KriyonNative: {
    addListener: jest.fn((_name: string, listener: never) => {
      frameListeners.push(listener);
      return { remove: jest.fn() };
    }),
    compose: jest.fn(() => Promise.resolve()),
    giveBack: jest.fn(() => Promise.resolve()),
    input: jest.fn(() => Promise.resolve()),
    resize: jest.fn(() => Promise.resolve()),
    setView: jest.fn(() => Promise.resolve()),
    takeControl: jest.fn(() => Promise.resolve()),
  },
}));

const native = jest.mocked(KriyonNative);
const MAC = "ab".repeat(32);

/**
 * A summary as Rust would send it: `typing` is who typed last, a hint;
 * `mayType` is Rust's word, a connected Controller (ADR-0063).
 */
const state = (
  over: Partial<HostSummary>,
  typing: "you" | "host" | "other",
  mayType = (over.link ?? "connected") === "connected" &&
    (over.role ?? "controller") === "controller"
): HostSummary => {
  const summary: HostSummary = {
    hostId: MAC,
    hostName: "Mac",
    link: "connected",
    mayStart: false,
    projects: [],
    refused: null,
    role: "controller",
    sessions: [],
    ...over,
  };
  return {
    ...summary,
    sessions: over.sessions ?? [
      {
        dialogOpen: false,
        id: "s1",
        lastChangeMs: 0,
        mayType,
        needsYou: false,
        projectId: "p",
        standing: "running",
        status: "running",
        title: "Fix the build",
        typing,
      },
    ],
  };
};

/** The page says it is ready, as the real one does once loaded. */
async function pageReady() {
  await act(() =>
    pageProps.onMessage({ nativeEvent: { data: '{"type":"ready"}' } })
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  injected.length = 0;
  frameListeners.length = 0;
  usePhone.setState(usePhone.getInitialState());
});

test("the session's screen comes on in Rust, and its frames reach the page once it is ready", async () => {
  usePhone.setState({ states: { [MAC]: state({}, "host") } });
  const view = await render(<TerminalView hostId={MAC} sessionId="s1" />);
  expect(native.setView).toHaveBeenLastCalledWith(
    MAC,
    "s1",
    expect.any(Number),
    true,
    "fresh",
    false
  );
  await act(() => {
    for (const listener of frameListeners) {
      listener({
        frame: new Uint8Array([0, 104, 105]),
        hostId: MAC,
        sessionId: "s1",
      });
      // Another session's frame is not this page's.
      listener({ frame: new Uint8Array([0, 1]), hostId: MAC, sessionId: "s2" });
    }
  });
  expect(injected.some((code) => code.includes("AGhp"))).toBe(false);
  await pageReady();
  expect(
    injected.some((code) => code.includes('window.kriyon.frame("AGhp")'))
  ).toBe(true);
  expect(injected.some((code) => code.includes("AAE"))).toBe(false);
  await view.unmount();
  // Its screen goes off; the session stays open (its screen's owner's).
  expect(native.setView).toHaveBeenLastCalledWith(
    MAC,
    "s1",
    expect.any(Number),
    true,
    "off",
    false
  );
});

test("a Controller types at once: there is no control to take or give back", async () => {
  usePhone.setState({ states: { [MAC]: state({}, "host") } });
  await render(<TerminalView hostId={MAC} sessionId="s1" />);
  await pageReady();
  expect(screen.getByLabelText("Type into the terminal")).toBeOnTheScreen();
  expect(screen.getByLabelText("Keys")).toBeOnTheScreen();
  expect(screen.queryByRole("button", { name: "Take control" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Give back" })).toBeNull();
  expect(screen.queryByText("Watching.")).toBeNull();
});

test("who typed last shows as a hint, never a lock", async () => {
  usePhone.setState({ states: { [MAC]: state({}, "host") } });
  await render(<TerminalView hostId={MAC} sessionId="s1" />);
  expect(
    screen.getByText("Someone typed last on that computer.")
  ).toBeOnTheScreen();
  await act(() => usePhone.getState().hostChanged(state({}, "other")));
  expect(screen.getByText("Another device typed last.")).toBeOnTheScreen();
  await act(() => usePhone.getState().hostChanged(state({}, "you")));
  expect(screen.queryByText("Another device typed last.")).toBeNull();
  expect(screen.getByLabelText("Type into the terminal")).toBeOnTheScreen();
});

test("a line the computer won't take as a message goes as typed keys, UTF-8, with its Enter", async () => {
  usePhone.setState({ states: { [MAC]: state({}, "you") } });
  await render(<TerminalView hostId={MAC} sessionId="s1" />);
  await fireEvent.changeText(
    screen.getByLabelText("Type into the terminal"),
    "é"
  );
  await fireEvent.press(screen.getByRole("button", { name: "Enter" }));
  expect(native.input).toHaveBeenCalledWith(
    MAC,
    "s1",
    new Uint8Array([0xc3, 0xa9, 13])
  );
  expect(native.compose).not.toHaveBeenCalled();
  expect(screen.getByLabelText("Type into the terminal").props.value).toBe("");
});

test("the extra keys send a terminal's keys, and ctrl makes the next letter a control key", async () => {
  usePhone.setState({ states: { [MAC]: state({}, "you") } });
  await render(<TerminalView hostId={MAC} sessionId="s1" />);
  await fireEvent.press(screen.getByRole("button", { name: "Escape" }));
  expect(native.input).toHaveBeenLastCalledWith(
    MAC,
    "s1",
    new Uint8Array([27])
  );
  await fireEvent.press(screen.getByRole("button", { name: "Up" }));
  expect(native.input).toHaveBeenLastCalledWith(
    MAC,
    "s1",
    new TextEncoder().encode("\u001b[A")
  );
  await fireEvent.press(screen.getByRole("switch", { name: "Control" }));
  await fireEvent.changeText(
    screen.getByLabelText("Type into the terminal"),
    "c"
  );
  await fireEvent.press(screen.getByRole("button", { name: "Enter" }));
  expect(native.input).toHaveBeenLastCalledWith(MAC, "s1", new Uint8Array([3]));
  // Ctrl lets go after one key.
  expect(
    screen.getByRole("switch", { name: "Control" }).props.accessibilityState
  ).toMatchObject({ checked: false });
});

test("a lost link says so and typing is off", async () => {
  usePhone.setState({
    states: { [MAC]: state({ link: "lost" }, "you", false) },
  });
  await render(<TerminalView hostId={MAC} sessionId="s1" />);
  await pageReady();
  expect(
    screen.getByText("Disconnected, reconnecting. Typing is off.")
  ).toBeOnTheScreen();
  expect(screen.queryByLabelText("Type into the terminal")).toBeNull();
});

test("the page is told the phone's light or dark, and again when it loads again", async () => {
  usePhone.setState({ states: { [MAC]: state({}, "you") } });
  await render(<TerminalView hostId={MAC} sessionId="s1" />);
  await pageReady();
  await act(() => Promise.resolve());
  expect(injected.some((code) => code.startsWith("window.kriyon.theme("))).toBe(
    true
  );
  expect(native.setView).toHaveBeenCalledTimes(1);
  injected.length = 0;
  // iOS ended the page's process; it loaded again: a fresh screen, on the
  // same open session.
  await pageReady();
  await act(() => Promise.resolve());
  expect(native.setView).toHaveBeenCalledTimes(2);
  expect(native.setView).toHaveBeenLastCalledWith(
    MAC,
    "s1",
    expect.any(Number),
    true,
    "fresh",
    false
  );
  expect(injected.some((code) => code.startsWith("window.kriyon.theme("))).toBe(
    true
  );
});

test("a note from the stream shows in the desktop's words", async () => {
  usePhone.setState({ states: { [MAC]: state({}, "host") } });
  await render(<TerminalView hostId={MAC} sessionId="s1" />);
  await act(() =>
    pageProps.onMessage({
      nativeEvent: { data: '{"type":"note","note":{"kind":"skipped"}}' },
    })
  );
  expect(
    screen.getByText(
      "Skipped ahead: this computer fell behind, so it shows the screen as it is now."
    )
  ).toBeOnTheScreen();
});

test("a Viewer may only watch", async () => {
  usePhone.setState({ states: { [MAC]: state({ role: "viewer" }, "host") } });
  await render(<TerminalView hostId={MAC} sessionId="s1" />);
  expect(screen.queryByLabelText("Type into the terminal")).toBeNull();
  expect(screen.getByText("This phone may only watch.")).toBeOnTheScreen();
});

test("while connecting or removed, the link's own words show and typing is off", async () => {
  usePhone.setState({
    states: { [MAC]: state({ link: "connecting" }, "host") },
  });
  const view = await render(<TerminalView hostId={MAC} sessionId="s1" />);
  expect(screen.getByText("Connecting…")).toBeOnTheScreen();
  expect(screen.queryByLabelText("Type into the terminal")).toBeNull();
  await act(() =>
    usePhone.getState().hostChanged(state({ link: "removed" }, "host"))
  );
  expect(
    screen.getByText("Removed from that computer. Pair again to use it.")
  ).toBeOnTheScreen();
  await view.unmount();
});

test("a session that is gone takes no typing", async () => {
  usePhone.setState({
    states: { [MAC]: { ...state({}, "host"), sessions: [] } },
  });
  await render(<TerminalView hostId={MAC} sessionId="s1" />);
  expect(screen.queryByLabelText("Type into the terminal")).toBeNull();
});

test("frames that pile up before the page loads are dropped for a fresh screen", async () => {
  usePhone.setState({ states: { [MAC]: state({}, "host") } });
  await render(<TerminalView hostId={MAC} sessionId="s1" />);
  await act(() => {
    for (let n = 0; n < 1000; n += 1) {
      for (const listener of frameListeners) {
        listener({
          frame: new Uint8Array([0, 65]),
          hostId: MAC,
          sessionId: "s1",
        });
      }
    }
  });
  await pageReady();
  await act(() => Promise.resolve());
  expect(
    injected.filter((code) => code.includes("frame(")).length
  ).toBeLessThan(300);
  expect(native.setView).toHaveBeenCalledTimes(2);
});

/** A summary with Claude asking `options` (none: a permission prompt). */
const asking = (options: string[], over: Partial<HostSummary> = {}) => {
  const summary = state(over, "host");
  const [one] = summary.sessions;
  return {
    ...summary,
    sessions: [
      {
        ...one,
        dialogOpen: true,
        mayCompose: false,
        question: { options, text: "Fix the failing test too?" },
      },
    ],
  };
};

test("while Claude asks, its choices answer it, each by its number key", async () => {
  usePhone.setState({ states: { [MAC]: asking(["Yes, fix it", "No"]) } });
  await render(<TerminalView hostId={MAC} sessionId="s1" />);
  // Free typing is off while Claude asks: the choices answer it.
  expect(screen.queryByLabelText("Type into the terminal")).toBeNull();
  expect(screen.getByText("Fix the failing test too?")).toBeOnTheScreen();
  await fireEvent.press(screen.getByRole("button", { name: "1. Yes, fix it" }));
  expect(native.input).toHaveBeenLastCalledWith(
    MAC,
    "s1",
    new TextEncoder().encode("1")
  );
  await fireEvent.press(screen.getByRole("button", { name: "Esc" }));
  expect(native.input).toHaveBeenLastCalledWith(
    MAC,
    "s1",
    new Uint8Array([27])
  );
});

test("a prompt whose choices aren't known is answered by arrows and Enter", async () => {
  // A number would pick a line the person can't name (in Claude's folder
  // trust prompt, 1 is "No, exit"): the highlight on screen shows instead.
  usePhone.setState({ states: { [MAC]: asking([]) } });
  await render(<TerminalView hostId={MAC} sessionId="s1" />);
  for (const name of ["↑", "↓", "Enter", "Esc"]) {
    expect(screen.getByRole("button", { name })).toBeOnTheScreen();
  }
  expect(screen.queryByRole("button", { name: "1" })).toBeNull();
  await fireEvent.press(screen.getByRole("button", { name: "↓" }));
  expect(native.input).toHaveBeenLastCalledWith(
    MAC,
    "s1",
    new TextEncoder().encode("\u001b[B")
  );
});

test("a Viewer is never offered an answer", async () => {
  usePhone.setState({ states: { [MAC]: asking(["Yes"], { role: "viewer" }) } });
  await render(<TerminalView hostId={MAC} sessionId="s1" />);
  expect(screen.queryByRole("button", { name: "Esc" })).toBeNull();
  expect(screen.queryByRole("button", { name: "1. Yes" })).toBeNull();
});

test("a line typed with no question showing goes as one compose", async () => {
  const summary = state({}, "you");
  const [one] = summary.sessions;
  usePhone.setState({
    states: {
      [MAC]: {
        ...summary,
        sessions: one ? [{ ...one, mayCompose: true }] : [],
      },
    },
  });
  await render(<TerminalView hostId={MAC} sessionId="s1" />);
  await fireEvent.changeText(
    screen.getByLabelText("Type into the terminal"),
    "ls"
  );
  await fireEvent.press(screen.getByRole("button", { name: "Enter" }));
  expect(native.compose).toHaveBeenCalledWith(MAC, "s1", "ls");
  expect(native.input).not.toHaveBeenCalled();
});

/** The page says what fits the phone, as the real one does once drawn. */
async function pageSize(cols: number, rows: number) {
  await act(() =>
    pageProps.onMessage({
      nativeEvent: { data: JSON.stringify({ cols, rows, type: "size" }) },
    })
  );
}

test("a Controller tells the computer the phone's own size, once for each new size", async () => {
  usePhone.setState({ states: { [MAC]: state({}, "host") } });
  await render(<TerminalView hostId={MAC} sessionId="s1" />);
  await pageReady();
  await pageSize(80, 40);
  await pageSize(80, 40);
  expect(native.resize).toHaveBeenCalledTimes(1);
  expect(native.resize).toHaveBeenLastCalledWith(MAC, "s1", 80, 40);
  // The keyboard took half the view.
  await pageSize(80, 20);
  expect(native.resize).toHaveBeenLastCalledWith(MAC, "s1", 80, 20);
});

test("a Viewer never sizes the computer's session", async () => {
  usePhone.setState({ states: { [MAC]: state({ role: "viewer" }, "host") } });
  await render(<TerminalView hostId={MAC} sessionId="s1" />);
  await pageReady();
  await pageSize(80, 40);
  expect(native.resize).not.toHaveBeenCalled();
});
