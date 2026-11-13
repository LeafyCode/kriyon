import { beforeEach, expect, jest, test } from "@jest/globals";
import { fireEvent, render, screen } from "@testing-library/react-native";
import {
  type HostState,
  KriyonNative,
  type PairedHost,
} from "../../modules/kriyon-native/index.ts";
import { usePhone } from "../state/phone.ts";
import { HomeScreen } from "./HomeScreen.tsx";
import { PairScreen } from "./PairScreen.tsx";

jest.mock("../../modules/kriyon-native/index.ts", () => ({
  KriyonNative: {
    addListener: jest.fn(() => ({ remove: jest.fn() })),
    cancelPairing: jest.fn(() => Promise.resolve()),
    finishPairing: jest.fn(),
    forget: jest.fn(() => Promise.resolve()),
    hosts: jest.fn(() => Promise.resolve([])),
    pair: jest.fn(),
    start: jest.fn(),
    wake: jest.fn(),
  },
}));

const native = jest.mocked(KriyonNative);
const MAC = "ab".repeat(32);

const paired: PairedHost = {
  addrs: [],
  hostId: MAC,
  name: "Mac",
  pairedAtMs: 1,
  relayUrl: null,
};

const connected: HostState = {
  hostId: MAC,
  hostName: "Mac",
  link: "connected",
  refused: null,
  role: "controller",
  sessions: [
    {
      dialogOpen: true,
      id: "s1",
      lastChangeMs: 2,
      needsYou: true,
      projectId: "p",
      standing: "awaiting_input",
      status: "waiting",
      title: "Fix the build",
      typing: null,
    },
    {
      dialogOpen: false,
      id: "s2",
      lastChangeMs: 1,
      needsYou: false,
      projectId: "p",
      standing: "running",
      status: "running",
      title: "Write the docs",
      typing: null,
    },
  ],
};

beforeEach(() => {
  jest.clearAllMocks();
  usePhone.setState(usePhone.getInitialState());
});

test("with no computer yet, home offers pairing", async () => {
  await render(<HomeScreen />);
  expect(screen.getByText("No computers yet.")).toBeOnTheScreen();
  await fireEvent.press(
    screen.getByRole("button", { name: "Pair a computer" })
  );
  expect(usePhone.getState().screen).toEqual({ kind: "pair" });
});

test("home leads with what needs you, then each computer's sessions", async () => {
  usePhone.setState({ hosts: [paired], states: { [MAC]: connected } });
  await render(<HomeScreen />);
  expect(screen.getByText("Needs you")).toBeOnTheScreen();
  // Once under Needs you, once under its computer.
  expect(screen.getAllByText("Fix the build")).toHaveLength(2);
  expect(screen.getByText("Write the docs")).toBeOnTheScreen();
  expect(screen.getByText("Running")).toBeOnTheScreen();
  await fireEvent.press(screen.getAllByText("Fix the build")[0]);
  expect(usePhone.getState().screen).toEqual({
    hostId: MAC,
    kind: "session",
    sessionId: "s1",
  });
});

test("a computer that is away says so, and its sessions don't need you here", async () => {
  usePhone.setState({
    hosts: [paired],
    states: { [MAC]: { ...connected, link: "lost" } },
  });
  await render(<HomeScreen />);
  expect(
    screen.getByText("Disconnected, reconnecting. Typing is off.")
  ).toBeOnTheScreen();
  expect(screen.queryByText("Needs you")).toBeNull();
});

test("pairing takes the pasted code and shows the digits to type there", async () => {
  native.pair.mockResolvedValue("123456");
  native.finishPairing.mockReturnValue(new Promise(() => undefined));
  await render(<PairScreen />);
  await fireEvent.changeText(
    screen.getByLabelText("Pairing code from the computer"),
    "kriyon-pair:abc"
  );
  await fireEvent.press(screen.getByRole("button", { name: "Connect" }));
  expect(await screen.findByText("123456")).toBeOnTheScreen();
  expect(native.pair).toHaveBeenCalledWith("kriyon-pair:abc");
  await fireEvent.press(screen.getByRole("button", { name: "Cancel" }));
  expect(native.cancelPairing).toHaveBeenCalled();
  expect(usePhone.getState().screen).toEqual({ kind: "home" });
});

test("a failed pairing says why", async () => {
  usePhone.setState({
    pairing: { phase: "failed", reason: "that isn't a Kriyon pairing code" },
  });
  await render(<PairScreen />);
  expect(
    screen.getByText("that isn't a Kriyon pairing code")
  ).toBeOnTheScreen();
});
