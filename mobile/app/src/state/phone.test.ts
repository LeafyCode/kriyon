import { beforeEach, expect, jest, test } from "@jest/globals";
import { steel } from "../../../../src/theme/themes/steel.ts";
import type {
  HostSession,
  HostState,
  PairedHost,
} from "../../modules/kriyon-native/index.ts";
import { KriyonNative } from "../../modules/kriyon-native/index.ts";
import { needsYou, standingMeta, usePhone } from "./phone.ts";

jest.mock("../../modules/kriyon-native/index.ts", () => ({
  KriyonNative: {
    addListener: jest.fn(() => ({ remove: jest.fn() })),
    cancelPairing: jest.fn(),
    finishPairing: jest.fn(),
    forget: jest.fn(),
    hosts: jest.fn(),
    pair: jest.fn(),
    start: jest.fn(),
    wake: jest.fn(),
  },
}));

const native = jest.mocked(KriyonNative);

const MAC = "ab".repeat(32);
const STUDIO = "cd".repeat(32);

const paired = (hostId: string, name: string): PairedHost => ({
  addrs: [],
  hostId,
  name,
  pairedAtMs: 1,
  relayUrl: null,
});

const session = (over: Partial<HostSession>): HostSession => ({
  dialogOpen: false,
  id: "s",
  lastChangeMs: 0,
  needsYou: false,
  projectId: "p",
  standing: "idle",
  status: "idle",
  title: "A session",
  typing: null,
  ...over,
});

const host = (over: Partial<HostState>): HostState => ({
  hostId: MAC,
  hostName: "Mac",
  link: "connected",
  refused: null,
  role: "controller",
  sessions: [],
  ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
  usePhone.setState(usePhone.getInitialState());
});

test("starting reads this phone's id and its computers", async () => {
  native.start.mockResolvedValue("ef".repeat(32));
  native.hosts.mockResolvedValue([paired(MAC, "Mac")]);
  await usePhone.getState().start("Test phone");
  const state = usePhone.getState();
  expect(state.deviceId).toBe("ef".repeat(32));
  expect(state.hosts.map((one) => one.name)).toEqual(["Mac"]);
  expect(native.start).toHaveBeenCalledWith("Test phone");
});

test("a start that fails says why", async () => {
  native.start.mockRejectedValue(new Error("keychain read failed (-25308)"));
  await usePhone.getState().start("Test phone");
  expect(usePhone.getState().startError).toBe("keychain read failed (-25308)");
});

test("pairing shows the code, then the computer it paired with", async () => {
  native.pair.mockResolvedValue("123456");
  native.finishPairing.mockResolvedValue(paired(MAC, "Mac"));
  native.hosts.mockResolvedValue([paired(MAC, "Mac")]);
  const done = usePhone.getState().pair("kriyon-pair:...");
  await Promise.resolve();
  await Promise.resolve();
  expect(usePhone.getState().pairing).toEqual({
    code: "123456",
    phase: "code",
  });
  await done;
  expect(usePhone.getState().pairing).toEqual({ name: "Mac", phase: "paired" });
  expect(usePhone.getState().hosts).toHaveLength(1);
});

test("an empty paste is refused before Rust", async () => {
  await usePhone.getState().pair("   ");
  expect(native.pair).not.toHaveBeenCalled();
  expect(usePhone.getState().pairing.phase).toBe("failed");
});

test("a pairing Rust refuses says why", async () => {
  native.pair.mockRejectedValue(new Error("that isn't a Kriyon pairing code"));
  await usePhone.getState().pair("hello");
  expect(usePhone.getState().pairing).toEqual({
    phase: "failed",
    reason: "that isn't a Kriyon pairing code",
  });
});

test("backing out of a pairing cancels it in Rust", async () => {
  native.cancelPairing.mockResolvedValue();
  usePhone.setState({ pairing: { code: "123456", phase: "code" } });
  await usePhone.getState().cancelPairing();
  expect(native.cancelPairing).toHaveBeenCalled();
  expect(usePhone.getState().pairing.phase).toBe("idle");
});

test("each computer's state is kept as Rust last said", () => {
  usePhone.getState().hostChanged(host({ link: "connecting" }));
  usePhone.getState().hostChanged(host({ link: "lost" }));
  expect(usePhone.getState().states[MAC]?.link).toBe("lost");
});

test("forgetting a computer drops it and its state, and leaves its screen", async () => {
  native.forget.mockResolvedValue();
  usePhone.setState({
    hosts: [paired(MAC, "Mac"), paired(STUDIO, "Studio")],
    screen: { hostId: MAC, kind: "session", sessionId: "s" },
    states: { [MAC]: host({}) },
  });
  await usePhone.getState().forget(MAC);
  const state = usePhone.getState();
  expect(state.hosts.map((one) => one.hostId)).toEqual([STUDIO]);
  expect(state.states[MAC]).toBeUndefined();
  expect(state.screen).toEqual({ kind: "home" });
});

test("needs you lists waiting sessions on connected computers, newest first", () => {
  const states = {
    [MAC]: host({
      sessions: [
        session({ id: "old", lastChangeMs: 1, needsYou: true }),
        session({ id: "busy", standing: "running" }),
        session({ id: "new", lastChangeMs: 9, needsYou: true }),
      ],
    }),
    [STUDIO]: host({
      hostId: STUDIO,
      link: "lost",
      sessions: [session({ id: "away", needsYou: true })],
    }),
  };
  const hosts = [paired(MAC, "Mac"), paired(STUDIO, "Studio")];
  expect(
    needsYou(hosts, states).map((one) => [one.host.name, one.session.id])
  ).toEqual([
    ["Mac", "new"],
    ["Mac", "old"],
  ]);
});

test("a computer that was forgotten is never listed, whatever Rust last said", () => {
  const states = {
    [STUDIO]: host({ hostId: STUDIO, sessions: [session({ needsYou: true })] }),
  };
  expect(needsYou([paired(MAC, "Mac")], states)).toEqual([]);
});

test("each standing reads as the desktop says it, in the theme's colour", () => {
  const { colors } = steel;
  expect(standingMeta("running", colors)).toEqual({
    color: colors.statusRunning,
    label: "Running",
  });
  expect(standingMeta("awaiting_input", colors)).toEqual({
    color: colors.statusWaiting,
    label: "Awaiting input",
  });
  expect(standingMeta("changed", colors).label).toBe("Changed");
  expect(standingMeta("idle", colors).label).toBe("Idle");
  expect(standingMeta("unknown", colors)).toEqual({
    color: colors.inkFaint,
    label: "Unknown",
  });
  expect(standingMeta("something-new", colors).label).toBe("Unknown");
});
