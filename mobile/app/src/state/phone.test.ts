import { beforeEach, expect, jest, test } from "@jest/globals";
import type { HostSummary } from "../../../../src/remote/hostSummary.ts";
import { steel } from "../../../../src/theme/themes/steel.ts";
import type { PairedHost } from "../../modules/kriyon-native/index.ts";
import { KriyonNative } from "../../modules/kriyon-native/index.ts";
import { standingMeta, toBase64, usePhone } from "./phone.ts";

jest.mock("../../modules/kriyon-native/index.ts", () => ({
  KriyonNative: {
    addListener: jest.fn(() => ({ remove: jest.fn() })),
    cancelPairing: jest.fn(),
    closeSession: jest.fn(),
    openSession: jest.fn(),
    finishPairing: jest.fn(),
    forget: jest.fn(),
    hosts: jest.fn(),
    pair: jest.fn(),
    start: jest.fn(),
    wake: jest.fn(),
  },
}));

jest.mock("./push.ts", () => ({
  registerPush: jest.fn(() => Promise.resolve("on")),
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

const host = (over: Partial<HostSummary>): HostSummary => ({
  hostId: MAC,
  hostName: "Mac",
  link: "connected",
  mayStart: false,
  projects: [],
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
  expect(state.push).toBe("on");
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
  const done = usePhone.getState().pair("kriyon-pair:1:ab");
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
  await usePhone.getState().pair("kriyon-pair:1:zz");
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

test("the phone's Back goes home from any screen, and leaves the app from home", () => {
  native.cancelPairing.mockResolvedValue();
  expect(usePhone.getState().back()).toBe(false);
  usePhone.setState({
    screen: { hostId: MAC, kind: "session", sessionId: "s1" },
  });
  expect(usePhone.getState().back()).toBe(true);
  expect(usePhone.getState().screen).toEqual({ kind: "home" });
  usePhone.setState({ screen: { hostId: MAC, kind: "new" } });
  expect(usePhone.getState().back()).toBe(true);
  expect(usePhone.getState().screen).toEqual({ kind: "home" });
});

test("Back from pairing cancels it in Rust, as its Cancel does", async () => {
  native.cancelPairing.mockResolvedValue();
  usePhone.setState({
    pairing: { code: "123456", phase: "code" },
    screen: { kind: "pair" },
  });
  expect(usePhone.getState().back()).toBe(true);
  await Promise.resolve();
  expect(native.cancelPairing).toHaveBeenCalled();
  expect(usePhone.getState().screen).toEqual({ kind: "home" });
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
});

test("bytes travel to the terminal page as base64", () => {
  expect(toBase64(new Uint8Array([]))).toBe("");
  expect(toBase64(new Uint8Array([104, 105]))).toBe("aGk=");
  expect(toBase64(new Uint8Array([0, 255, 27, 91]))).toBe("AP8bWw==");
  const big = new Uint8Array(100_000).fill(65);
  expect(toBase64(big)).toHaveLength(133_336);
});

test("a session's open and close reach Rust in the order asked", async () => {
  const order: string[] = [];
  let opened: () => void = () => undefined;
  native.openSession.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        order.push("open starts");
        opened = () => {
          order.push("open ends");
          resolve();
        };
      })
  );
  native.closeSession.mockImplementation(() => {
    order.push("close");
    return Promise.resolve();
  });
  const { closeSession, openSession } = usePhone.getState();
  const open = openSession(MAC, "s");
  const close = closeSession(MAC, "s");
  await Promise.resolve();
  expect(order).toEqual(["open starts"]);
  opened();
  await Promise.all([open, close]);
  expect(order).toEqual(["open starts", "open ends", "close"]);
});

test("a failed open doesn't stop the next one", async () => {
  native.openSession.mockRejectedValueOnce(new Error("NotConnected"));
  native.openSession.mockResolvedValueOnce();
  const { openSession } = usePhone.getState();
  await expect(openSession(MAC, "s")).rejects.toThrow("NotConnected");
  await expect(openSession(MAC, "s")).resolves.toBeUndefined();
});
