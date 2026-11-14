import { beforeEach, expect, test, vi } from "vitest";
import {
  remoteHostForget,
  remoteHostInput,
  remoteHostPair,
  remoteHostSetView,
  remoteHostStartSession,
  remoteHosts,
  remoteHostsWake,
  remoteHostTakeControl,
} from "../ipc/bridge.ts";
import type { HostSummary, SessionSummary } from "../remote/hostSummary.ts";
import {
  installRemoteHostListeners,
  readableOf,
  remoteNeedsYouCount,
  useRemoteHosts,
} from "./remoteHosts.ts";

vi.mock("../ipc/bridge.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../ipc/bridge.ts")>()),
  remoteHostForget: vi.fn(),
  remoteHostInput: vi.fn(),
  remoteHostPair: vi.fn(),
  remoteHostSetView: vi.fn(),
  remoteHosts: vi.fn(),
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

/** The views asked of Rust, in order: [seq, open, screen, entries read]. */
function viewsAsked(): [number, boolean, string, boolean][] {
  return vi
    .mocked(remoteHostSetView)
    .mock.calls.map(([, , seq, view]) => [
      seq,
      view !== null,
      typeof view?.screen === "object" ? "fresh" : (view?.screen ?? "off"),
      Boolean(view?.onEntries),
    ]);
}

test("each change to a session's view goes to Rust whole, numbered, without waiting", () => {
  // Rust is slow to answer: nothing waits on it.
  vi.mocked(remoteHostSetView).mockReturnValue(
    new Promise<void>(() => undefined)
  );
  const store = useRemoteHosts.getState();
  store.open(HOST, "s1");
  store.showScreen(HOST, "s1", vi.fn());
  store.readEntries(HOST, "s1");
  store.hideScreen(HOST, "s1");
  store.close(HOST, "s1");
  const asked = viewsAsked();
  // The screen is asked for fresh only when shown; else kept as it is.
  expect(asked.map(([, ...rest]) => rest)).toEqual([
    [true, "off", false],
    [true, "fresh", false],
    [true, "kept", true],
    [true, "off", true],
    [false, "off", false],
  ]);
  const seqs = asked.map(([seq]) => seq);
  expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
  expect(new Set(seqs).size).toBe(seqs.length);
});

test("reading a session as entries keeps what Rust last sent; stopping forgets it", async () => {
  vi.mocked(remoteHostSetView).mockResolvedValue();
  const store = useRemoteHosts.getState();
  await store.open(HOST, "s1");
  await store.readEntries(HOST, "s1");
  const [last] = vi.mocked(remoteHostSetView).mock.calls.slice(-1);
  const view = last?.[3];
  expect(view?.onEntries).toBeTruthy();
  view?.onEntries?.({
    entries: [{ kind: "note", seq: 1, text: "Hi" }],
    unavailable: null,
  });
  expect(readableOf(HOST, "s1")?.entries).toHaveLength(1);
  await store.stopEntries(HOST, "s1");
  const [lastAsked] = viewsAsked().slice(-1);
  expect(lastAsked?.slice(1)).toEqual([true, "off", false]);
  expect(readableOf(HOST, "s1")).toBeUndefined();
});

test("views are numbered above any a page loaded before could have asked", async () => {
  vi.mocked(remoteHostSetView).mockResolvedValue();
  const before = Date.now() * 1000;
  await useRemoteHosts.getState().open(HOST, "s1");
  const [[seq]] = viewsAsked();
  expect(seq).toBeGreaterThanOrEqual(before);
});

test("forgetting a computer forgets its sessions' views", async () => {
  vi.mocked(remoteHostSetView).mockResolvedValue();
  vi.mocked(remoteHostForget).mockResolvedValue();
  vi.mocked(remoteHosts).mockResolvedValue([]);
  const store = useRemoteHosts.getState();
  await store.showScreen(HOST, "s1", vi.fn());
  await store.forget(HOST);
  vi.mocked(remoteHostSetView).mockClear();
  // Its terminal goes as the computer does: nothing left to hide there.
  await store.hideScreen(HOST, "s1");
  expect(remoteHostSetView).not.toHaveBeenCalled();
  expect(useRemoteHosts.getState().error).toBeNull();
});

test("hiding a screen Rust won't take is no failure", async () => {
  vi.mocked(remoteHostSetView).mockResolvedValueOnce();
  await useRemoteHosts.getState().showScreen(HOST, "s1", vi.fn());
  vi.mocked(remoteHostSetView).mockRejectedValueOnce("not paired");
  await useRemoteHosts.getState().hideScreen(HOST, "s1");
  expect(useRemoteHosts.getState().error).toBeNull();
});

test("hiding the screen of a session already closed asks Rust nothing", async () => {
  await useRemoteHosts.getState().hideScreen(HOST, "s1");
  expect(remoteHostSetView).not.toHaveBeenCalled();
  expect(useRemoteHosts.getState().error).toBeNull();
});

test("a view Rust won't take says why", async () => {
  vi.mocked(remoteHostSetView).mockRejectedValue("not paired");
  await useRemoteHosts.getState().open(HOST, "s1");
  expect(useRemoteHosts.getState().error).toBe("not paired");
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
