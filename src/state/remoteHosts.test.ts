import { beforeEach, expect, test, vi } from "vitest";
import {
  remoteHostCloseSession,
  remoteHostForget,
  remoteHostHideScreen,
  remoteHostInput,
  remoteHostOpenSession,
  remoteHostPair,
  remoteHostReadEntries,
  remoteHostShowScreen,
  remoteHostStartSession,
  remoteHostStopEntries,
  remoteHosts,
  remoteHostsWake,
  remoteHostTakeControl,
} from "../ipc/bridge.ts";
import type { HostSummary, SessionSummary } from "../remote/hostSummary.ts";
import type { ReadableSummary } from "../remote/readableSummary.ts";
import {
  installRemoteHostListeners,
  readableOf,
  remoteNeedsYouCount,
  useRemoteHosts,
} from "./remoteHosts.ts";

vi.mock("../ipc/bridge.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../ipc/bridge.ts")>()),
  remoteHostCloseSession: vi.fn(),
  remoteHostForget: vi.fn(),
  remoteHostHideScreen: vi.fn(),
  remoteHostInput: vi.fn(),
  remoteHostOpenSession: vi.fn(),
  remoteHostPair: vi.fn(),
  remoteHostReadEntries: vi.fn(),
  remoteHostShowScreen: vi.fn(),
  remoteHosts: vi.fn(),
  remoteHostStopEntries: vi.fn(),
  remoteHostStartSession: vi.fn(),
  remoteHostsWake: vi.fn(),
  remoteHostTakeControl: vi.fn(),
}));

const HOST = "ab".repeat(32);
const studio = { hostId: HOST, name: "Studio", pairedAt: 1 };

function session(over: Partial<SessionSummary> = {}): SessionSummary {
  return {
    dialogOpen: false,
    id: "s1",
    lastChangeMs: 0,
    mayType: false,
    needsYou: true,
    projectId: "/work/app",
    standing: "awaiting_input",
    status: "waiting",
    title: "Fix login",
    typing: null,
    ...over,
  };
}

function link(over: Partial<HostSummary> = {}): HostSummary {
  return {
    hostId: HOST,
    hostName: "Studio",
    link: "connected",
    mayStart: true,
    projects: [{ id: "/work/app", name: "app", parked: false }],
    refused: null,
    role: "controller",
    sessions: [session()],
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
  useRemoteHosts.getState().linkChanged(link({ link: "lost" }));
  expect(useRemoteHosts.getState().links[HOST]?.link).toBe("lost");
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
  const first = store.open(HOST, "s1");
  const closed = store.close(HOST, "s1");
  const second = store.open(HOST, "s1");
  await vi.waitFor(() => expect(remoteHostOpenSession).toHaveBeenCalled());
  expect(remoteHostCloseSession).not.toHaveBeenCalled();
  finishFirstOpen();
  await Promise.all([first, closed, second]);
  expect(order).toEqual(["open 1", "close", "open 2"]);
});

test("reading a session as entries goes after its open and keeps what Rust last sent", async () => {
  const order: string[] = [];
  let finishOpen: () => void = () => {
    // Replaced once Rust's open is under way.
  };
  vi.mocked(remoteHostOpenSession).mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finishOpen = () => {
          order.push("open");
          resolve();
        };
      })
  );
  let send: (summary: ReadableSummary) => void = () => {
    // Replaced when Rust starts reading.
  };
  vi.mocked(remoteHostReadEntries).mockImplementation((_h, _s, onEntries) => {
    order.push("read");
    send = onEntries;
    return Promise.resolve();
  });
  const store = useRemoteHosts.getState();
  const opened = store.open(HOST, "s1");
  const reading = store.readEntries(HOST, "s1");
  await vi.waitFor(() => expect(remoteHostOpenSession).toHaveBeenCalled());
  expect(remoteHostReadEntries).not.toHaveBeenCalled();
  finishOpen();
  await Promise.all([opened, reading]);
  expect(order).toEqual(["open", "read"]);
  send({
    entries: [{ kind: "note", seq: 1, text: "Hi" }],
    unavailable: null,
  });
  expect(readableOf(HOST, "s1")?.entries).toHaveLength(1);
  await store.stopEntries(HOST, "s1");
  expect(remoteHostStopEntries).toHaveBeenCalledWith(HOST, "s1");
  expect(readableOf(HOST, "s1")).toBeUndefined();
});

test("the screen is shown and hidden after the open, in the order asked", async () => {
  const order: string[] = [];
  vi.mocked(remoteHostOpenSession).mockImplementation(() => {
    order.push("open");
    return Promise.resolve();
  });
  vi.mocked(remoteHostShowScreen).mockImplementation(() => {
    order.push("show");
    return Promise.resolve();
  });
  vi.mocked(remoteHostHideScreen).mockImplementation(() => {
    order.push("hide");
    return Promise.resolve();
  });
  const store = useRemoteHosts.getState();
  await Promise.all([
    store.open(HOST, "s1"),
    store.showScreen(HOST, "s1", vi.fn()),
    store.hideScreen(HOST, "s1"),
  ]);
  expect(order).toEqual(["open", "show", "hide"]);
});

test("a failure to open says why", async () => {
  vi.mocked(remoteHostOpenSession).mockRejectedValue("not connected");
  await useRemoteHosts.getState().open(HOST, "s1");
  expect(useRemoteHosts.getState().error).toBe("not connected");
});

test("only sessions on a connected, still-paired computer count as needing you", () => {
  const other = "cd".repeat(32);
  useRemoteHosts.setState({ hosts: [studio] });
  useRemoteHosts.getState().linkChanged(link());
  expect(remoteNeedsYouCount(useRemoteHosts.getState())).toBe(1);
  useRemoteHosts.getState().linkChanged(link({ link: "removed" }));
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
    .linkChanged(
      link({ sessions: [session({ mayType: true, typing: "you" })] })
    );
  await useRemoteHosts.getState().type(HOST, "s1", "y");
  expect(remoteHostInput).toHaveBeenCalledWith(HOST, "s1", "y");
});

test("taking control asks Rust", async () => {
  vi.mocked(remoteHostTakeControl).mockResolvedValue();
  await useRemoteHosts.getState().takeControl(HOST, "s1");
  expect(remoteHostTakeControl).toHaveBeenCalledWith(HOST, "s1");
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

test("starting a session asks Rust, says it is under way, and keeps what it started", async () => {
  let answer: (id: string) => void = () => undefined;
  vi.mocked(remoteHostStartSession).mockReturnValue(
    new Promise((resolve) => {
      answer = resolve;
    })
  );
  const starting = useRemoteHosts
    .getState()
    .startSession(HOST, "/work/app", "Fix login");
  expect(useRemoteHosts.getState().starting[HOST]).toBe(true);
  answer("new-session");
  await expect(starting).resolves.toBe("new-session");
  expect(remoteHostStartSession).toHaveBeenCalledWith(
    HOST,
    "/work/app",
    "Fix login"
  );
  expect(useRemoteHosts.getState().starting[HOST]).toBeFalsy();
  expect(useRemoteHosts.getState().started).toEqual({
    hostId: HOST,
    sessionId: "new-session",
  });
  useRemoteHosts.getState().takeStarted();
  expect(useRemoteHosts.getState().started).toBeNull();
});

test("a refused start says why for that computer only", async () => {
  vi.mocked(remoteHostStartSession).mockRejectedValue(
    "This device isn't allowed to do that."
  );
  const started = await useRemoteHosts
    .getState()
    .startSession(HOST, "/work/app", "");
  expect(started).toBeNull();
  expect(useRemoteHosts.getState().startErrors[HOST]).toBe(
    "This device isn't allowed to do that."
  );
  expect(
    useRemoteHosts.getState().startErrors["cd".repeat(32)]
  ).toBeUndefined();
  useRemoteHosts.getState().clearStartError(HOST);
  expect(useRemoteHosts.getState().startErrors[HOST]).toBeUndefined();
});
