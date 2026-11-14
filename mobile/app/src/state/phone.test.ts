import { beforeEach, expect, jest, test } from "@jest/globals";
import type { HostSummary } from "../../../../src/remote/hostSummary.ts";
import type { PairedHost } from "../../modules/kriyon-native/index.ts";
import { KriyonNative } from "../../modules/kriyon-native/index.ts";
import { readableKey, toBase64, usePhone } from "./phone.ts";

jest.mock("../../modules/kriyon-native/index.ts", () => ({
  KriyonNative: {
    addListener: jest.fn(() => ({ remove: jest.fn() })),
    alertsOn: jest.fn(() => true),
    cancelPairing: jest.fn(),
    compose: jest.fn(),
    finishPairing: jest.fn(),
    forget: jest.fn(),
    giveBack: jest.fn(),
    hosts: jest.fn(),
    input: jest.fn(),
    pair: jest.fn(),
    setAlerts: jest.fn(),
    setView: jest.fn(),
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

test("pairing shows the code with the role and time the computer offers", async () => {
  native.pair.mockResolvedValue(
    '{"code":"123456","role":"controller","expiresAtMs":1800000000000}'
  );
  native.finishPairing.mockReturnValue(new Promise(() => undefined));
  usePhone.getState().pair("kriyon-pair:1:ab");
  await Promise.resolve();
  await Promise.resolve();
  expect(usePhone.getState().pairing).toEqual({
    code: "123456",
    expiresAtMs: 1_800_000_000_000,
    phase: "code",
    role: "controller",
  });
});

test("a code step without its role or time still shows the code", async () => {
  native.pair.mockResolvedValue('{"code":"654321","role":"admin"}');
  native.finishPairing.mockReturnValue(new Promise(() => undefined));
  usePhone.getState().pair("kriyon-pair:1:ab");
  await Promise.resolve();
  await Promise.resolve();
  expect(usePhone.getState().pairing).toEqual({
    code: "654321",
    expiresAtMs: null,
    phase: "code",
    role: null,
  });
});

test("pairing shows the code, then the computer it paired with", async () => {
  native.pair.mockResolvedValue('{"code":"123456"}');
  native.finishPairing.mockResolvedValue(paired(MAC, "Mac"));
  native.hosts.mockResolvedValue([paired(MAC, "Mac")]);
  const done = usePhone.getState().pair("kriyon-pair:1:ab");
  await Promise.resolve();
  await Promise.resolve();
  expect(usePhone.getState().pairing).toMatchObject({
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

/** The views asked of Rust, as [seq, open, screen, entries]. */
function viewsAsked(): [number, boolean, string, boolean][] {
  return native.setView.mock.calls.map(
    ([, , seq, open, screen, entries]) =>
      [seq, open, screen, entries] as [number, boolean, string, boolean]
  );
}

test("each change to a session's view goes to Rust whole, numbered, without waiting", () => {
  // Rust is slow to answer: nothing waits on it.
  native.setView.mockReturnValue(new Promise<void>(() => undefined));
  const { closeReadable, hideScreen, openReadable, showScreen } =
    usePhone.getState();
  openReadable(MAC, "s");
  showScreen(MAC, "s");
  hideScreen(MAC, "s");
  closeReadable(MAC, "s");
  const asked = viewsAsked();
  expect(
    asked.map(([, open, screen, entries]) => [open, screen, entries])
  ).toEqual([
    [true, "off", true],
    [true, "fresh", true],
    [true, "off", true],
    [false, "off", false],
  ]);
  const seqs = asked.map(([seq]) => seq);
  expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
  expect(new Set(seqs).size).toBe(seqs.length);
  expect(
    native.setView.mock.calls.every(
      ([host, session]) => host === MAC && session === "s"
    )
  ).toBe(true);
});

const ENTRIES = {
  entries: [
    { kind: "you" as const, seq: 1, text: "Fix the login bug" },
    { done: false, kind: "claude" as const, seq: 2, text: "Looking" },
  ],
  unavailable: null,
};

test("views are numbered above any a run of the app before could have asked", async () => {
  native.setView.mockResolvedValue();
  const before = Date.now() * 1000;
  await usePhone.getState().openReadable(MAC, "s1");
  expect(viewsAsked()[0]?.[0]).toBeGreaterThanOrEqual(before);
});

test("a screen asked for again comes fresh; one already on stays as it is otherwise", async () => {
  native.setView.mockResolvedValue();
  const { openReadable, retryReadable, showScreen } = usePhone.getState();
  await showScreen(MAC, "s1");
  await showScreen(MAC, "s1");
  await openReadable(MAC, "s1");
  expect(viewsAsked().map(([, , screen]) => screen)).toEqual([
    "fresh",
    "fresh",
    "kept",
  ]);
  retryReadable(MAC, "s1");
});

test("forgetting a computer forgets its sessions' views", async () => {
  native.setView.mockResolvedValue();
  native.forget.mockResolvedValue();
  await usePhone.getState().showScreen(MAC, "s1");
  await usePhone.getState().forget(MAC);
  expect(usePhone.getState().views).toEqual({});
});

test("entries are kept whole as Rust last sent them, for their session only", async () => {
  native.setView.mockResolvedValue();
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

test("a view Rust won't take is said by the view, not as no entries", async () => {
  native.setView.mockRejectedValue(new Error("not paired"));
  await expect(usePhone.getState().openReadable(MAC, "s1")).rejects.toThrow(
    "not paired"
  );
  expect(usePhone.getState().readable[readableKey(MAC, "s1")]).toBeUndefined();
});

test("entries for a session not being read are dropped", () => {
  usePhone
    .getState()
    .entriesChanged({ hostId: MAC, sessionId: "s1", summary: ENTRIES });
  expect(usePhone.getState().readable[readableKey(MAC, "s1")]).toBeUndefined();
});

test("closing drops the entries, and keeps only why there were none", async () => {
  native.setView.mockResolvedValue();
  const { closeReadable, entriesChanged, openReadable } = usePhone.getState();
  await openReadable(MAC, "s1");
  entriesChanged({ hostId: MAC, sessionId: "s1", summary: ENTRIES });
  await closeReadable(MAC, "s1");
  expect(viewsAsked().at(-1)?.[1]).toBe(false);
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

test("trying again asks Rust for the entries afresh, the session staying open", async () => {
  native.setView.mockResolvedValue();
  const { openReadable, retryReadable, showScreen } = usePhone.getState();
  await openReadable(MAC, "s1");
  await showScreen(MAC, "s1");
  usePhone.setState({
    readable: { [readableKey(MAC, "s1")]: { entries: [], unavailable: "off" } },
  });
  native.setView.mockClear();
  retryReadable(MAC, "s1");
  // Off, then on: a new read, from the start.
  expect(
    viewsAsked().map(([, open, screen, entries]) => [open, screen, entries])
  ).toEqual([
    [true, "kept", false],
    [true, "kept", true],
  ]);
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

test("a message goes to Claude as one compose, the computer typing it", async () => {
  native.compose.mockResolvedValue();
  await usePhone.getState().sendMessage(MAC, "s1", "run the tests");
  expect(native.compose).toHaveBeenCalledWith(MAC, "s1", "run the tests");
  expect(native.input).not.toHaveBeenCalled();
});

test("giving back control tells Rust", async () => {
  native.giveBack.mockResolvedValue();
  await usePhone.getState().giveBack(MAC, "s1");
  expect(native.giveBack).toHaveBeenCalledWith(MAC, "s1");
});

test("alerts start as the phone left them, and turning them off tells Rust", async () => {
  native.start.mockResolvedValue("ef".repeat(32));
  native.hosts.mockResolvedValue([]);
  native.alertsOn.mockReturnValue(false);
  await usePhone.getState().start("Test phone");
  expect(usePhone.getState().alertsOn).toBe(false);
  native.setAlerts.mockResolvedValue();
  await usePhone.getState().setAlerts(true);
  expect(native.setAlerts).toHaveBeenCalledWith(true);
  expect(usePhone.getState().alertsOn).toBe(true);
});

test("alerts Rust couldn't change stay as they were, saying why", async () => {
  usePhone.setState({ alertsOn: true });
  native.setAlerts.mockRejectedValue(new Error("store locked"));
  await usePhone.getState().setAlerts(false);
  expect(usePhone.getState().alertsOn).toBe(true);
  expect(usePhone.getState().alertsError).toBe("store locked");
});
