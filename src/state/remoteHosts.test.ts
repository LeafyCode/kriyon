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
  installRemoteHostListeners,
  remoteNeedsYouCount,
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

test("opening and closing one session reach Rust in the order asked", async () => {
  const order: string[] = [];
  let finishFirstOpen: () => void = () => {
    // Replaced once Rust's first open is under way.
  };
  vi.mocked(remoteHostOpenSession)
    .mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishFirstOpen = () => {
            order.push("open 1");
            resolve();
          };
        })
    )
    .mockImplementationOnce(() => {
      order.push("open 2");
      return Promise.resolve();
    });
  vi.mocked(remoteHostCloseSession).mockImplementation(() => {
    order.push("close");
    return Promise.resolve();
  });
  const store = useRemoteHosts.getState();
  // Shown, hidden and shown again before Rust finished the first open.
  const first = store.open(HOST, "s1", vi.fn());
  const closed = store.close(HOST, "s1");
  const second = store.open(HOST, "s1", vi.fn());
  await vi.waitFor(() => expect(remoteHostOpenSession).toHaveBeenCalled());
  expect(remoteHostCloseSession).not.toHaveBeenCalled();
  finishFirstOpen();
  await Promise.all([first, closed, second]);
  expect(order).toEqual(["open 1", "close", "open 2"]);
});

test("a failure to open says why", async () => {
  vi.mocked(remoteHostOpenSession).mockRejectedValue("not connected");
  await useRemoteHosts.getState().open(HOST, "s1", vi.fn());
  expect(useRemoteHosts.getState().error).toBe("not connected");
});

test("only sessions on a connected, still-paired computer count as needing you", () => {
  const other = "cd".repeat(32);
  useRemoteHosts.setState({ hosts: [studio] });
  useRemoteHosts.getState().linkChanged(link());
  expect(remoteNeedsYouCount(useRemoteHosts.getState())).toBe(1);
  useRemoteHosts.getState().linkChanged(link({ state: "removed" }));
  expect(remoteNeedsYouCount(useRemoteHosts.getState())).toBe(0);
  useRemoteHosts.getState().linkChanged(link());
  useRemoteHosts.getState().linkChanged(link({ hostId: other }));
  expect(remoteNeedsYouCount(useRemoteHosts.getState())).toBe(1);
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

test("the app wakes reconnects when its window comes back to the front", () => {
  vi.mocked(remoteHostsWake).mockResolvedValue();
  const stop = installRemoteHostListeners();
  window.dispatchEvent(new Event("focus"));
  expect(remoteHostsWake).toHaveBeenCalledTimes(1);
  stop();
  window.dispatchEvent(new Event("focus"));
  expect(remoteHostsWake).toHaveBeenCalledTimes(1);
});
