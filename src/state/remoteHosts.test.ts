import { beforeEach, expect, test, vi } from "vitest";
import {
  type HostLink,
  type HostSession,
  remoteHostCloseSession,
  remoteHostForget,
  remoteHostInput,
  remoteHostOpenSession,
  remoteHostPair,
  remoteHosts,
  remoteHostsWake,
  remoteHostTakeControl,
} from "../ipc/bridge.ts";
import {
  canType,
  decodeScreenFrame,
  installRemoteHostListeners,
  linkLine,
  useRemoteHosts,
} from "./remoteHosts.ts";

vi.mock("../ipc/bridge.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../ipc/bridge.ts")>()),
  remoteHostCloseSession: vi.fn(),
  remoteHostForget: vi.fn(),
  remoteHostInput: vi.fn(),
  remoteHostOpenSession: vi.fn(),
  remoteHostPair: vi.fn(),
  remoteHosts: vi.fn(),
  remoteHostsWake: vi.fn(),
  remoteHostTakeControl: vi.fn(),
}));

const HOST = "ab".repeat(32);
const studio = { hostId: HOST, name: "Studio", pairedAt: 1 };

function session(over: Partial<HostSession> = {}): HostSession {
  return {
    dialogOpen: false,
    id: "s1",
    lastChangeMs: 0,
    mine: false,
    needsYou: true,
    standing: "awaiting_input",
    status: "waiting",
    title: "Fix login",
    ...over,
  };
}

function link(over: Partial<HostLink> = {}): HostLink {
  return {
    hostId: HOST,
    name: "Studio",
    role: "controller",
    sessions: [session()],
    state: "connected",
    ...over,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  useRemoteHosts.setState(useRemoteHosts.getInitialState());
  vi.mocked(remoteHosts).mockResolvedValue([]);
});

test("a screen frame says what to draw", () => {
  expect(decodeScreenFrame(new Uint8Array([0, 104, 105]))).toEqual({
    bytes: new Uint8Array([104, 105]),
    kind: "output",
  });
  expect(decodeScreenFrame(new Uint8Array([1, 1, 44, 0, 2, 1, 120]))).toEqual({
    bytes: new Uint8Array([120]),
    cols: 300,
    kind: "screen",
    rows: 2,
    skipped: true,
  });
  expect(decodeScreenFrame(new Uint8Array([2, 1]))).toEqual({
    kind: "receipt",
    written: true,
  });
  expect(decodeScreenFrame(new Uint8Array([3, 4]))).toEqual({
    kind: "refused",
    reason: 4,
  });
  for (const bad of [[], [1, 0, 80], [9, 1]]) {
    expect(decodeScreenFrame(new Uint8Array(bad))).toBeNull();
  }
});

test("loading lists the paired computers", async () => {
  vi.mocked(remoteHosts).mockResolvedValue([studio]);
  await useRemoteHosts.getState().load();
  expect(useRemoteHosts.getState().hosts).toEqual([studio]);
});

test("pairing shows the code to type there, then how it ended", async () => {
  vi.mocked(remoteHostPair).mockResolvedValue("123456");
  await useRemoteHosts.getState().pair("  kriyon-pair:1:00  ");
  expect(remoteHostPair).toHaveBeenCalledWith("kriyon-pair:1:00");
  expect(useRemoteHosts.getState().pairing).toEqual({
    code: "123456",
    phase: "code",
  });

  vi.mocked(remoteHosts).mockResolvedValue([studio]);
  await useRemoteHosts
    .getState()
    .pairingEnded({ hostId: HOST, name: "Studio", outcome: "paired" });
  expect(useRemoteHosts.getState().pairing).toEqual({
    name: "Studio",
    phase: "paired",
  });
  expect(useRemoteHosts.getState().hosts).toEqual([studio]);
});

test("a pairing that failed says why", async () => {
  await useRemoteHosts
    .getState()
    .pairingEnded({ outcome: "failed", reason: "refused: NotPaired" });
  expect(useRemoteHosts.getState().pairing).toEqual({
    phase: "failed",
    reason: "refused: NotPaired",
  });
});

test("an empty paste is refused before Rust", async () => {
  await useRemoteHosts.getState().pair("   ");
  expect(remoteHostPair).not.toHaveBeenCalled();
  expect(useRemoteHosts.getState().pairing).toEqual({
    phase: "failed",
    reason: "Paste the pairing code from the other computer.",
  });
});

test("a pairing Rust refuses at once says why", async () => {
  vi.mocked(remoteHostPair).mockRejectedValue(
    "that isn't a Kriyon pairing code"
  );
  await useRemoteHosts.getState().pair("hello");
  expect(useRemoteHosts.getState().pairing).toEqual({
    phase: "failed",
    reason: "that isn't a Kriyon pairing code",
  });
});

test("each computer's link is kept as Rust last said", () => {
  useRemoteHosts.getState().linkChanged(link());
  expect(useRemoteHosts.getState().links[HOST]).toEqual(link());
  useRemoteHosts.getState().linkChanged(link({ state: "lost" }));
  expect(useRemoteHosts.getState().links[HOST]?.state).toBe("lost");
});

test("forgetting a computer drops it and its link", async () => {
  vi.mocked(remoteHostForget).mockResolvedValue();
  useRemoteHosts.getState().linkChanged(link());
  await useRemoteHosts.getState().forget(HOST);
  expect(remoteHostForget).toHaveBeenCalledWith(HOST);
  expect(useRemoteHosts.getState().links[HOST]).toBeUndefined();
});

test("opening a session shows it, and closing it lets it go", async () => {
  vi.mocked(remoteHostOpenSession).mockResolvedValue();
  vi.mocked(remoteHostCloseSession).mockResolvedValue();
  const frames = vi.fn();
  await useRemoteHosts.getState().open(HOST, "s1", frames);
  expect(remoteHostOpenSession).toHaveBeenCalledWith(HOST, "s1", frames);
  expect(useRemoteHosts.getState().opened).toEqual({
    hostId: HOST,
    sessionId: "s1",
  });
  await useRemoteHosts.getState().close();
  expect(remoteHostCloseSession).toHaveBeenCalledWith(HOST, "s1");
  expect(useRemoteHosts.getState().opened).toBeNull();
});

test("typing goes only where this computer holds control", async () => {
  vi.mocked(remoteHostInput).mockResolvedValue();
  useRemoteHosts.getState().linkChanged(link());
  await useRemoteHosts.getState().type(HOST, "s1", "y");
  expect(remoteHostInput).not.toHaveBeenCalled();
  useRemoteHosts
    .getState()
    .linkChanged(link({ sessions: [session({ mine: true })] }));
  await useRemoteHosts.getState().type(HOST, "s1", "y");
  expect(remoteHostInput).toHaveBeenCalledWith(HOST, "s1", "y");
});

test("taking control asks Rust", async () => {
  vi.mocked(remoteHostTakeControl).mockResolvedValue();
  await useRemoteHosts.getState().takeControl(HOST, "s1");
  expect(remoteHostTakeControl).toHaveBeenCalledWith(HOST, "s1");
});

test("typing is on only while connected, as a Controller, with control", () => {
  const mine = session({ mine: true });
  expect(canType(link({ sessions: [mine] }), mine)).toBe(true);
  expect(canType(link({ sessions: [mine], state: "lost" }), mine)).toBe(false);
  expect(canType(link({ role: "viewer", sessions: [mine] }), mine)).toBe(false);
  expect(canType(link(), session())).toBe(false);
});

test("each link state has its line", () => {
  expect(linkLine("lost")).toBe("Disconnected, reconnecting. Typing is off.");
  expect(linkLine("removed")).toBe(
    "Removed from that computer. Pair again to use it."
  );
  expect(linkLine("connecting")).toBe("Connecting…");
  expect(linkLine("connected")).toBe("Connected");
});

test("the app wakes reconnects when its window comes back to the front", () => {
  vi.mocked(remoteHostsWake).mockResolvedValue();
  const stop = installRemoteHostListeners();
  window.dispatchEvent(new Event("focus"));
  expect(remoteHostsWake).toHaveBeenCalledTimes(1);
  stop();
  window.dispatchEvent(new Event("focus"));
  expect(remoteHostsWake).toHaveBeenCalledTimes(1);
});
