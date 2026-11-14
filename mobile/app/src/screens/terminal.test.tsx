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
const mockRequestFocus = jest.fn();
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
        requestFocus: mockRequestFocus,
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
    input: jest.fn(() => Promise.resolve()),
    setScreen: jest.fn(() => Promise.resolve()),
    takeControl: jest.fn(() => Promise.resolve()),
  },
}));

const native = jest.mocked(KriyonNative);
const MAC = "ab".repeat(32);

/**
 * A summary as Rust would send it: `typing` is who holds control, `mayType`
 * what Rust says of it (cases off the link set it themselves).
 */
const state = (
  over: Partial<HostSummary>,
  typing: "you" | "host",
  mayType = typing === "you"
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
  mockRequestFocus.mockClear();
  frameListeners.length = 0;
  usePhone.setState(usePhone.getInitialState());
});

test("the session's screen comes on in Rust, and its frames reach the page once it is ready", async () => {
  usePhone.setState({ states: { [MAC]: state({}, "host") } });
  const view = await render(<TerminalView hostId={MAC} sessionId="s1" />);
  expect(native.setScreen).toHaveBeenCalledWith(MAC, "s1", true);
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
  expect(native.setScreen).toHaveBeenLastCalledWith(MAC, "s1", false);
});

test("typing is off until this phone holds control, and Take control asks Rust", async () => {
  usePhone.setState({ states: { [MAC]: state({}, "host") } });
  await render(<TerminalView hostId={MAC} sessionId="s1" />);
  await pageReady();
  expect(injected).toContain("window.kriyon.typing(false);true;");
  await fireEvent.press(screen.getByRole("button", { name: "Take control" }));
  expect(native.takeControl).toHaveBeenCalledWith(MAC, "s1");
  await act(() => usePhone.getState().hostChanged(state({}, "you")));
  expect(injected).toContain("window.kriyon.typing(true);true;");
  expect(screen.queryByRole("button", { name: "Take control" })).toBeNull();
});

test("with control the web view takes the phone's focus, so Android shows the keyboard", async () => {
  usePhone.setState({ states: { [MAC]: state({}, "host") } });
  await render(<TerminalView hostId={MAC} sessionId="s1" />);
  await pageReady();
  expect(mockRequestFocus).not.toHaveBeenCalled();
  await act(() => usePhone.getState().hostChanged(state({}, "you")));
  expect(mockRequestFocus).toHaveBeenCalled();
});

test("what is typed goes to Rust as UTF-8", async () => {
  usePhone.setState({ states: { [MAC]: state({}, "you") } });
  await render(<TerminalView hostId={MAC} sessionId="s1" />);
  await act(() =>
    pageProps.onMessage({
      nativeEvent: { data: '{"type":"input","data":"é\\r"}' },
    })
  );
  expect(native.input).toHaveBeenCalledWith(
    MAC,
    "s1",
    new Uint8Array([0xc3, 0xa9, 13])
  );
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
  expect(injected).toContain("window.kriyon.typing(false);true;");
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

test("a Viewer is never offered control", async () => {
  usePhone.setState({ states: { [MAC]: state({ role: "viewer" }, "host") } });
  await render(<TerminalView hostId={MAC} sessionId="s1" />);
  expect(screen.queryByRole("button", { name: "Take control" })).toBeNull();
  expect(screen.getByText("This phone may only watch.")).toBeOnTheScreen();
});

test("while connecting or removed, the link's own words show and control isn't offered", async () => {
  usePhone.setState({
    states: { [MAC]: state({ link: "connecting" }, "host") },
  });
  const view = await render(<TerminalView hostId={MAC} sessionId="s1" />);
  expect(screen.getByText("Connecting…")).toBeOnTheScreen();
  expect(screen.queryByRole("button", { name: "Take control" })).toBeNull();
  await act(() =>
    usePhone.getState().hostChanged(state({ link: "removed" }, "host"))
  );
  expect(
    screen.getByText("Removed from that computer. Pair again to use it.")
  ).toBeOnTheScreen();
  await view.unmount();
});

test("a session that is gone offers no control", async () => {
  usePhone.setState({
    states: { [MAC]: { ...state({}, "host"), sessions: [] } },
  });
  await render(<TerminalView hostId={MAC} sessionId="s1" />);
  expect(screen.queryByRole("button", { name: "Take control" })).toBeNull();
});

test("a page that loads again gets the session afresh, and its typing state", async () => {
  usePhone.setState({ states: { [MAC]: state({}, "you") } });
  await render(<TerminalView hostId={MAC} sessionId="s1" />);
  await pageReady();
  await act(() => Promise.resolve());
  expect(native.setScreen).toHaveBeenCalledTimes(1);
  injected.length = 0;
  // iOS ended the page's process; it loaded again: a fresh screen, on the
  // same open session.
  await pageReady();
  await act(() => Promise.resolve());
  expect(native.setScreen).toHaveBeenCalledTimes(2);
  expect(native.setScreen).toHaveBeenLastCalledWith(MAC, "s1", true);
  expect(injected).toContain("window.kriyon.typing(true);true;");
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
  expect(native.setScreen).toHaveBeenCalledTimes(2);
});
