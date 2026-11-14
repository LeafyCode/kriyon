/**
 * What a screen reader (TalkBack, VoiceOver) is told, screen by screen:
 * each control's name, role and state, what is grouped into one reading,
 * and what is hidden because something else already says it.
 */
import { beforeEach, expect, jest, test } from "@jest/globals";
import {
  act,
  fireEvent,
  isHiddenFromAccessibility,
  render,
  renderHook,
  screen,
} from "@testing-library/react-native";
import { AccessibilityInfo } from "react-native";
import type { HostSummary } from "../../../../src/remote/hostSummary.ts";
import type { ReadableSummary } from "../../../../src/remote/readableSummary.ts";
import { useReduceMotion } from "../kit.tsx";
import { usePhone } from "../state/phone.ts";
import { HomeScreen } from "./HomeScreen.tsx";
import { NewSessionSheet } from "./NewSessionScreen.tsx";
import { PairScreen } from "./PairScreen.tsx";
import { SessionScreen } from "./SessionScreen.tsx";

jest.mock("react-native-webview", () => {
  const { View } =
    jest.requireActual<typeof import("react-native")>("react-native");
  return { WebView: () => <View testID="terminal-page" /> };
});
jest.mock("../terminal/page.generated.ts", () => ({ TERMINAL_PAGE: "" }));
jest.mock("./RelaySection.tsx", () => ({ RelaySection: () => null }));
jest.mock("../../modules/kriyon-native/index.ts", () => ({
  KriyonNative: {
    addListener: jest.fn(() => ({ remove: jest.fn() })),
    closeSession: jest.fn(() => Promise.resolve()),
    input: jest.fn(() => Promise.resolve()),
    openSession: jest.fn(() => Promise.resolve()),
    readEntries: jest.fn(() => Promise.resolve()),
    setScreen: jest.fn(() => Promise.resolve()),
    takeControl: jest.fn(() => Promise.resolve()),
  },
}));

const MAC = "ab".repeat(32);
const paired = {
  addrs: [],
  hostId: MAC,
  name: "Mac",
  pairedAtMs: 1,
  relayUrl: null,
};

const session = (
  over: Partial<HostSummary["sessions"][number]>
): HostSummary["sessions"][number] => ({
  dialogOpen: false,
  id: "s1",
  lastChangeMs: 0,
  mayType: false,
  needsYou: false,
  projectId: "api",
  standing: "idle",
  status: "idle",
  title: "Fix the build",
  typing: null,
  ...over,
});

const mac = (over: Partial<HostSummary> = {}): HostSummary => ({
  hostId: MAC,
  hostName: "Mac",
  link: "connected",
  mayStart: true,
  projects: [
    { id: "api", name: "api-server", parked: false },
    { id: "web", name: "website", parked: false },
  ],
  refused: null,
  role: "controller",
  sessions: [
    session({
      dialogOpen: true,
      needsYou: true,
      standing: "awaiting_input",
      status: "waiting",
    }),
    session({
      id: "s2",
      standing: "running",
      status: "running",
      title: "Write the docs",
    }),
  ],
  ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
  usePhone.setState(usePhone.getInitialState());
});

test("home reads its count as one sentence, and the bar once, not again by its legend", async () => {
  usePhone.setState({ hosts: [paired], states: { [MAC]: mac() } });
  await render(<HomeScreen />);
  expect(screen.getByLabelText("2 sessions, 1 needs you")).toBeOnTheScreen();
  expect(
    screen.getByLabelText("1 asking, 0 your turn, 1 running, 0 idle")
  ).toBeOnTheScreen();
  expect(
    isHiddenFromAccessibility(
      screen.getByText("1 asking", { includeHiddenElements: true })
    )
  ).toBe(true);
});

test("the Needs you heading says its count with it", async () => {
  usePhone.setState({ hosts: [paired], states: { [MAC]: mac() } });
  await render(<HomeScreen />);
  expect(
    screen.getByRole("header", { name: "Needs you, 1" })
  ).toBeOnTheScreen();
});

test("the filter chips are tabs that say which is chosen", async () => {
  usePhone.setState({ hosts: [paired], states: { [MAC]: mac() } });
  await render(<HomeScreen />);
  expect(screen.getByRole("tab", { name: "All" })).toBeSelected();
  expect(screen.getByRole("tab", { name: "Running · 1" })).not.toBeSelected();
});

const CONVERSATION: ReadableSummary = {
  entries: [
    { kind: "you", seq: 1, text: "Fix the login bug" },
    { done: true, kind: "claude", seq: 2, text: "The form sends too early." },
    {
      kind: "step",
      name: "Read",
      seq: 3,
      state: "done",
      target: "src/login.ts",
    },
    {
      header: "Tests",
      kind: "asking",
      options: ["Yes", "No"],
      question: "Fix the failing test too?",
      seq: 4,
    },
  ],
  unavailable: null,
};

test("the readable view reads what was said, by whom, and each step in one go", async () => {
  usePhone.setState({ hosts: [paired], states: { [MAC]: mac() } });
  await render(<SessionScreen hostId={MAC} sessionId="s1" />);
  await act(() =>
    usePhone
      .getState()
      .entriesChanged({ hostId: MAC, sessionId: "s1", summary: CONVERSATION })
  );
  expect(
    screen.getByLabelText("You said: Fix the login bug")
  ).toBeOnTheScreen();
  expect(
    screen.getByLabelText("Claude: The form sends too early.")
  ).toBeOnTheScreen();
  expect(screen.getByLabelText("Read src/login.ts, done")).toBeOnTheScreen();
  // The question is read as it is, and its button stays a button of its own.
  expect(screen.getByText("Fix the failing test too?")).toBeOnTheScreen();
  expect(
    screen.getByRole("button", { name: "Answer in the terminal" })
  ).toBeOnTheScreen();
});

test("the ctrl key is a switch that says when it's held", async () => {
  usePhone.setState({
    hosts: [paired],
    states: {
      [MAC]: mac({ sessions: [session({ mayType: true, typing: "you" })] }),
    },
  });
  await render(
    <SessionScreen hostId={MAC} initialView="terminal" sessionId="s1" />
  );
  const ctrl = screen.getByRole("switch", { name: "Control" });
  expect(ctrl).not.toBeChecked();
  await fireEvent.press(ctrl);
  expect(screen.getByRole("switch", { name: "Control" })).toBeChecked();
});

test("the new session sheet reads its own Close only: the scrim behind is silent", async () => {
  usePhone.setState({ hosts: [paired], states: { [MAC]: mac() } });
  await render(<NewSessionSheet hostId={MAC} />);
  expect(screen.getAllByRole("button", { name: "Close" })).toHaveLength(1);
  expect(
    screen.getByRole("radio", { name: "api-server, 2 open sessions" })
  ).toBeChecked();
});

test("pairing says which step it's on, as one reading", async () => {
  await render(<PairScreen />);
  const steps = screen.getByLabelText("Step 1 of 2");
  expect(steps.props.accessible).toBe(true);
});

test("motion follows the phone's Reduce motion, and its changes", async () => {
  let changed: ((on: boolean) => void) | undefined;
  jest
    .spyOn(AccessibilityInfo, "isReduceMotionEnabled")
    .mockResolvedValue(true);
  jest
    .spyOn(AccessibilityInfo, "addEventListener")
    .mockImplementation((_event, handler) => {
      changed = handler as (on: boolean) => void;
      return { remove: jest.fn() } as unknown as ReturnType<
        typeof AccessibilityInfo.addEventListener
      >;
    });
  const { result } = await renderHook(() => useReduceMotion());
  await act(() => Promise.resolve());
  expect(result.current).toBe(true);
  await act(() => changed?.(false));
  expect(result.current).toBe(false);
});
