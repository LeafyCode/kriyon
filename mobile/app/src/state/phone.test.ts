import { beforeEach, expect, jest, test } from "@jest/globals";
import type { HostSummary } from "../../../../src/remote/hostSummary.ts";
import type { PairedHost } from "../../modules/kriyon-native/index.ts";
import { KriyonNative } from "../../modules/kriyon-native/index.ts";
import { readableKey, toBase64, usePhone } from "./phone.ts";

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
    readEntries: jest.fn(),
    setScreen: jest.fn(),
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

test("bytes travel to the terminal page as base64", () => {
  expect(toBase64(new Uint8Array([]))).toBe("");
  expect(toBase64(new Uint8Array([104, 105]))).toBe("aGk=");
  expect(toBase64(new Uint8Array([0, 255, 27, 91]))).toBe("AP8bWw==");
  const big = new Uint8Array(100_000).fill(65);
  expect(toBase64(big)).toHaveLength(133_336);
});

test("a session's open, screen and close reach Rust in the order asked", async () => {
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
  native.readEntries.mockResolvedValue();
  native.setScreen.mockImplementation((_host, _session, on) => {
    order.push(on ? "screen on" : "screen off");
    return Promise.resolve();
  });
  native.closeSession.mockImplementation(() => {
    order.push("close");
    return Promise.resolve();
  });
  const { closeReadable, hideScreen, openReadable, showScreen } =
    usePhone.getState();
  const steps = [
    openReadable(MAC, "s"),
    showScreen(MAC, "s"),
    hideScreen(MAC, "s"),
    closeReadable(MAC, "s"),
  ];
  await Promise.resolve();
  expect(order).toEqual(["open starts"]);
  opened();
  await Promise.all(steps);
  expect(order).toEqual([
    "open starts",
    "open ends",
    "screen on",
    "screen off",
    "close",
  ]);
});

test("a failed screen doesn't stop the next one", async () => {
  native.setScreen.mockRejectedValueOnce(new Error("NotOpen"));
  native.setScreen.mockResolvedValueOnce();
  const { showScreen } = usePhone.getState();
  await expect(showScreen(MAC, "s")).rejects.toThrow("NotOpen");
  await expect(showScreen(MAC, "s")).resolves.toBeUndefined();
});

const ENTRIES = {
  entries: [
    { kind: "you" as const, seq: 1, text: "Fix the login bug" },
    { done: false, kind: "claude" as const, seq: 2, text: "Looking" },
  ],
  unavailable: null,
};

test("the readable view opens the session, then reads its entries", async () => {
  const order: string[] = [];
  native.openSession.mockImplementation(() => {
    order.push("open");
    return Promise.resolve();
  });
  native.readEntries.mockImplementation(() => {
    order.push("read");
    return Promise.resolve();
  });
  await usePhone.getState().openReadable(MAC, "s1");
  expect(order).toEqual(["open", "read"]);
  expect(native.readEntries).toHaveBeenCalledWith(MAC, "s1");
});

test("entries are kept whole as Rust last sent them, for their session only", async () => {
  native.openSession.mockResolvedValue();
  native.readEntries.mockResolvedValue();
  const { entriesChanged, openReadable } = usePhone.getState();
  await openReadable(MAC, "s1");
  entriesChanged({ hostId: MAC, sessionId: "s1", summary: ENTRIES });
  const grown = {
    ...ENTRIES,
    entries: [
      ENTRIES.entries[0],
      { done: true, kind: "claude" as const, seq: 2, text: "Looking at it" },
    ],
  };
  entriesChanged({ hostId: MAC, sessionId: "s1", summary: grown });
  expect(usePhone.getState().readable[readableKey(MAC, "s1")]).toEqual(grown);
  expect(usePhone.getState().readable[readableKey(MAC, "s2")]).toBeUndefined();
});

test("a read that fails shows the terminal, saying why", async () => {
  native.openSession.mockResolvedValue();
  native.readEntries.mockRejectedValue(new Error("not connected"));
  await usePhone.getState().openReadable(MAC, "s1");
  expect(usePhone.getState().readable[readableKey(MAC, "s1")]).toEqual({
    entries: [],
    unavailable: "not connected",
  });
});

test("a session that can't be opened is said by the view, not as no entries", async () => {
  native.openSession.mockRejectedValue(new Error("not connected"));
  await expect(usePhone.getState().openReadable(MAC, "s1")).rejects.toThrow(
    "not connected"
  );
  expect(native.readEntries).not.toHaveBeenCalled();
  expect(usePhone.getState().readable[readableKey(MAC, "s1")]).toBeUndefined();
});

test("entries for a session not being read are dropped", () => {
  usePhone
    .getState()
    .entriesChanged({ hostId: MAC, sessionId: "s1", summary: ENTRIES });
  expect(usePhone.getState().readable[readableKey(MAC, "s1")]).toBeUndefined();
});

test("closing drops the entries, and keeps only why there were none", async () => {
  native.openSession.mockResolvedValue();
  native.readEntries.mockResolvedValue();
  native.closeSession.mockResolvedValue();
  const { closeReadable, entriesChanged, openReadable } = usePhone.getState();
  await openReadable(MAC, "s1");
  entriesChanged({ hostId: MAC, sessionId: "s1", summary: ENTRIES });
  await closeReadable(MAC, "s1");
  expect(native.closeSession).toHaveBeenCalledWith(MAC, "s1");
  expect(usePhone.getState().readable[readableKey(MAC, "s1")]).toBeUndefined();
  await openReadable(MAC, "s1");
  const off = { entries: [], unavailable: "The Kriyon Companion is off." };
  entriesChanged({ hostId: MAC, sessionId: "s1", summary: off });
  await closeReadable(MAC, "s1");
  expect(usePhone.getState().readable[readableKey(MAC, "s1")]).toEqual(off);
  // Late news from the closed read changes nothing.
  entriesChanged({ hostId: MAC, sessionId: "s1", summary: ENTRIES });
  expect(usePhone.getState().readable[readableKey(MAC, "s1")]).toEqual(off);
});

test("trying again, or leaving the session, forgets why there were none", () => {
  const off = { entries: [], unavailable: "off" };
  const key = readableKey(MAC, "s1");
  usePhone.setState({ readable: { [key]: off } });
  usePhone.getState().retryReadable(MAC, "s1");
  expect(usePhone.getState().readable[key]).toBeUndefined();
  usePhone.setState({ readable: { [key]: off } });
  usePhone.getState().forgetReadable(MAC, "s1");
  expect(usePhone.getState().readable[key]).toBeUndefined();
});

test("trying again keeps entries being read", () => {
  const key = readableKey(MAC, "s1");
  usePhone.setState({ readable: { [key]: ENTRIES } });
  usePhone.getState().retryReadable(MAC, "s1");
  expect(usePhone.getState().readable[key]).toEqual(ENTRIES);
});
