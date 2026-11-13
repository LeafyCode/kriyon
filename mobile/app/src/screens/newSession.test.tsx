import { beforeEach, expect, jest, test } from "@jest/globals";
import { fireEvent, render, screen } from "@testing-library/react-native";
import type { HostSummary } from "../../../../src/remote/hostSummary.ts";
import {
  KriyonNative,
  type PairedHost,
} from "../../modules/kriyon-native/index.ts";
import { usePhone } from "../state/phone.ts";
import { HomeScreen } from "./HomeScreen.tsx";
import { NewSessionScreen } from "./NewSessionScreen.tsx";

jest.mock("../../modules/kriyon-native/index.ts", () => ({
  KriyonNative: {
    forget: jest.fn(() => Promise.resolve()),
    startSession: jest.fn(),
  },
}));

jest.mock("./RelaySection.tsx", () => ({ RelaySection: () => null }));

const native = jest.mocked(KriyonNative);
const MAC = "ab".repeat(32);

const paired: PairedHost = {
  addrs: [],
  hostId: MAC,
  name: "Mac",
  pairedAtMs: 1,
  relayUrl: null,
};

/** A summary as Rust would send it; cases set mayStart as Rust would. */
const host = (over: Partial<HostSummary> = {}): HostSummary => ({
  hostId: MAC,
  hostName: "Mac",
  link: "connected",
  mayStart: true,
  projects: [
    { id: "p1", name: "app", parked: false },
    { id: "p2", name: "old-site", parked: true },
  ],
  refused: null,
  role: "controller",
  sessions: [],
  ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
  usePhone.setState(usePhone.getInitialState());
});

test("home offers a new session only where one can start", async () => {
  usePhone.setState({
    hosts: [paired],
    states: { [MAC]: host({ mayStart: false, role: "viewer" }) },
  });
  const view = await render(<HomeScreen />);
  expect(
    screen.queryByRole("button", { name: "New session on Mac" })
  ).toBeNull();
  await view.unmount();
  usePhone.setState({ states: { [MAC]: host() } });
  await render(<HomeScreen />);
  await fireEvent.press(
    screen.getByRole("button", { name: "New session on Mac" })
  );
  expect(usePhone.getState().screen).toEqual({ hostId: MAC, kind: "new" });
});

test("starting in a project opens the new session", async () => {
  native.startSession.mockResolvedValue("s9");
  usePhone.setState({
    hosts: [paired],
    screen: { hostId: MAC, kind: "new" },
    states: { [MAC]: host() },
  });
  await render(<NewSessionScreen hostId={MAC} />);
  expect(screen.getByText("old-site (parked)")).toBeOnTheScreen();
  await fireEvent.changeText(
    screen.getByLabelText("Title (optional)"),
    "Fix the build"
  );
  await fireEvent.press(screen.getByRole("button", { name: "Start in app" }));
  expect(native.startSession).toHaveBeenCalledWith(MAC, "p1", "Fix the build");
  expect(usePhone.getState().screen).toEqual({
    hostId: MAC,
    kind: "session",
    sessionId: "s9",
  });
});

test("no title asks the computer to name it after the project", async () => {
  native.startSession.mockResolvedValue("s9");
  usePhone.setState({ hosts: [paired], states: { [MAC]: host() } });
  await render(<NewSessionScreen hostId={MAC} />);
  await fireEvent.press(screen.getByRole("button", { name: "Start in app" }));
  expect(native.startSession).toHaveBeenCalledWith(MAC, "p1", null);
});

test("a refusal shows the computer's words and stays", async () => {
  native.startSession.mockRejectedValue(
    Object.assign(new Error("That folder isn't one you approved."), {
      code: "Refused",
    })
  );
  usePhone.setState({ hosts: [paired], states: { [MAC]: host() } });
  await render(<NewSessionScreen hostId={MAC} />);
  await fireEvent.press(screen.getByRole("button", { name: "Start in app" }));
  expect(
    await screen.findByText("That folder isn't one you approved.")
  ).toBeOnTheScreen();
  expect(usePhone.getState().screen).toEqual({ kind: "home" });
  expect(native.startSession).toHaveBeenCalledTimes(1);
});

test("a session that starts after the person left doesn't pull them back", async () => {
  let started: (id: string) => void = () => undefined;
  native.startSession.mockReturnValue(
    new Promise<string>((resolve) => {
      started = resolve;
    })
  );
  usePhone.setState({
    screen: { hostId: MAC, kind: "new" },
    states: { [MAC]: host() },
  });
  const done = usePhone.getState().newSession(MAC, "p1", "");
  usePhone.getState().show({ kind: "pair" });
  started("s9");
  await done;
  expect(usePhone.getState().screen).toEqual({ kind: "pair" });
});

test("two quick starts start one session", () => {
  native.startSession.mockReturnValue(new Promise(() => undefined));
  usePhone.setState({
    screen: { hostId: MAC, kind: "new" },
    states: { [MAC]: host() },
  });
  usePhone
    .getState()
    .newSession(MAC, "p1", "")
    .catch(() => undefined);
  usePhone
    .getState()
    .newSession(MAC, "p2", "")
    .catch(() => undefined);
  expect(native.startSession).toHaveBeenCalledTimes(1);
});

test("an old refusal is gone once the screen changes", () => {
  usePhone.setState({ newSessionError: "That folder isn't one you approved." });
  usePhone.getState().show({ hostId: MAC, kind: "new" });
  expect(usePhone.getState().newSessionError).toBeNull();
});

test("where a session can't start now, the screen says why and offers nothing", async () => {
  usePhone.setState({
    hosts: [paired],
    states: { [MAC]: host({ link: "lost", mayStart: false }) },
  });
  await render(<NewSessionScreen hostId={MAC} />);
  expect(screen.queryByRole("button", { name: "Start in app" })).toBeNull();
  expect(
    screen.getByText(
      "A new session starts here while this phone is connected as a Controller."
    )
  ).toBeOnTheScreen();
});
