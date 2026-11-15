import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";
import { remoteHostInput, remoteHostSetView } from "../ipc/bridge.ts";
import { useLayout } from "../state/layout.ts";
import { useRemoteHosts } from "../state/remoteHosts.ts";
import type { HostSummary } from "./hostSummary.ts";
import { RemoteTerminal } from "./RemoteTerminal.tsx";

vi.mock("@xterm/xterm/css/xterm.css", () => ({}));

const termHolder = vi.hoisted(() => ({
  current: undefined as
    | {
        dispose: ReturnType<typeof vi.fn>;
        onDataCb?: (data: string) => void;
        options: Record<string, unknown>;
        reset: ReturnType<typeof vi.fn>;
        resize: ReturnType<typeof vi.fn>;
        write: ReturnType<typeof vi.fn>;
      }
    | undefined,
}));

vi.mock("@xterm/xterm", () => ({
  Terminal: class FakeTerminal {
    options: Record<string, unknown>;
    dispose = vi.fn();
    reset = vi.fn();
    resize = vi.fn();
    write = vi.fn();
    onDataCb?: (data: string) => void;
    constructor(options: Record<string, unknown>) {
      this.options = { ...options };
      termHolder.current = this;
    }
    open() {
      // The fake draws nothing.
    }
    onData(cb: (data: string) => void) {
      this.onDataCb = cb;
      return { dispose: vi.fn() };
    }
  },
}));

vi.mock("../ipc/bridge.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../ipc/bridge.ts")>()),
  remoteHostInput: vi.fn(() => Promise.resolve()),
  remoteHostSetView: vi.fn(() => Promise.resolve()),
}));

const SKIPPED_AHEAD = /Skipped ahead/;
const ONLY_WATCH = /only watch/;
const TYPED_THERE = /typed last on that computer/;
const HOST = "ab".repeat(32);

/**
 * A summary as Rust would send it: `mine` is this computer holding control,
 * `mayType` what Rust says of it (cases off the link set it themselves).
 */
function link(
  over: Partial<HostSummary> = {},
  mine = false,
  mayType = mine
): HostSummary {
  const summary: HostSummary = {
    hostId: HOST,
    hostName: "Studio",
    link: "connected",
    mayStart: false,
    refused: null,
    role: "controller",
    projects: [],
    sessions: [],
    ...over,
  };
  return {
    ...summary,
    sessions: [
      {
        dialogOpen: false,
        id: "s1",
        lastChangeMs: 0,
        mayType,
        needsYou: false,
        projectId: "p",
        standing: "running",
        status: "running",
        title: "Fix login",
        typing: mine ? "you" : "host",
      },
    ],
  };
}

function frames(): (frame: Uint8Array) => void {
  const [call] = vi.mocked(remoteHostSetView).mock.calls.slice(-1);
  const screen = call?.[3]?.screen;
  if (typeof screen !== "object") {
    throw new Error("not shown");
  }
  return screen.fresh;
}

beforeEach(() => {
  vi.clearAllMocks();
  useRemoteHosts.setState(useRemoteHosts.getInitialState());
  useRemoteHosts.getState().linkChanged(link());
});

test("turns the screen on when shown and off when it goes", async () => {
  const { unmount } = render(<RemoteTerminal hostId={HOST} sessionId="s1" />);
  await act(() => Promise.resolve());
  expect(remoteHostSetView).toHaveBeenLastCalledWith(
    HOST,
    "s1",
    expect.any(Number),
    { onEntries: null, screen: { fresh: expect.any(Function) } }
  );
  unmount();
  await vi.waitFor(() =>
    expect(remoteHostSetView).toHaveBeenLastCalledWith(
      HOST,
      "s1",
      expect.any(Number),
      { onEntries: null, screen: "off" }
    )
  );
  expect(termHolder.current?.dispose).toHaveBeenCalled();
});

test("draws the other computer's screen at its size", async () => {
  render(<RemoteTerminal hostId={HOST} sessionId="s1" />);
  await act(() => Promise.resolve());
  act(() => frames()(new Uint8Array([1, 0, 100, 0, 30, 0, 65])));
  expect(termHolder.current?.resize).toHaveBeenCalledWith(100, 30);
  expect(termHolder.current?.write).toHaveBeenCalledWith(new Uint8Array([65]));
  expect(screen.queryByText(SKIPPED_AHEAD)).toBeNull();
});

test("a screen sent because this computer fell behind says so", async () => {
  render(<RemoteTerminal hostId={HOST} sessionId="s1" />);
  await act(() => Promise.resolve());
  act(() => frames()(new Uint8Array([1, 0, 80, 0, 24, 1])));
  expect(screen.getByText(SKIPPED_AHEAD)).toBeTruthy();
});

// ADR-0063: no control to take. A Controller types at once, even right
// after the other computer did; it only hears who typed last.
test("a Controller types at once, with nothing to take first", async () => {
  useRemoteHosts.getState().linkChanged(link({}, false, true));
  render(<RemoteTerminal hostId={HOST} sessionId="s1" />);
  await act(() => Promise.resolve());
  expect(screen.queryByRole("button", { name: "Take control" })).toBeNull();
  expect(termHolder.current?.options.disableStdin).toBe(false);
  await act(async () => {
    termHolder.current?.onDataCb?.("y");
    await Promise.resolve();
  });
  expect(remoteHostInput).toHaveBeenCalledWith(HOST, "s1", "y");
  expect(screen.getByText(TYPED_THERE)).toBeTruthy();
});

test("a Viewer only watches", async () => {
  useRemoteHosts.getState().linkChanged(link({ role: "viewer" }));
  render(<RemoteTerminal hostId={HOST} sessionId="s1" />);
  await act(() => Promise.resolve());
  expect(termHolder.current?.options.disableStdin).toBe(true);
  act(() => termHolder.current?.onDataCb?.("y"));
  expect(remoteHostInput).not.toHaveBeenCalled();
  expect(screen.getByText(ONLY_WATCH)).toBeTruthy();
});

test("with control, typing goes to the other computer", async () => {
  useRemoteHosts.getState().linkChanged(link({}, true));
  render(<RemoteTerminal hostId={HOST} sessionId="s1" />);
  await act(() => Promise.resolve());
  expect(termHolder.current?.options.disableStdin).toBe(false);
  await act(async () => {
    termHolder.current?.onDataCb?.("y");
    await Promise.resolve();
  });
  expect(remoteHostInput).toHaveBeenCalledWith(HOST, "s1", "y");
});

test("a lost link dims the screen and turns typing off", async () => {
  useRemoteHosts.getState().linkChanged(link({}, true));
  render(<RemoteTerminal hostId={HOST} sessionId="s1" />);
  await act(() => Promise.resolve());
  act(() =>
    useRemoteHosts.getState().linkChanged(link({ link: "lost" }, true, false))
  );
  expect(
    screen.getByText("Disconnected, reconnecting. Typing is off.")
  ).toBeTruthy();
  expect(termHolder.current?.options.disableStdin).toBe(true);
  expect(screen.getByTestId("remote-screen").style.opacity).toBe("0.4");
});

test("a refusal and a receipt are said in plain words", async () => {
  render(<RemoteTerminal hostId={HOST} sessionId="s1" />);
  await act(() => Promise.resolve());
  act(() =>
    frames()(
      new Uint8Array([
        3,
        3,
        ...new TextEncoder().encode("You don't have control of this session."),
      ])
    )
  );
  expect(
    screen.getByText("You don't have control of this session.")
  ).toBeTruthy();
  act(() => frames()(new Uint8Array([2, 0])));
  expect(screen.getByText("Not sure it arrived.")).toBeTruthy();
});

test("a failure to show the screen or take control says why", async () => {
  vi.mocked(remoteHostSetView).mockRejectedValueOnce("not connected");
  render(<RemoteTerminal hostId={HOST} sessionId="s1" />);
  expect(await screen.findByText("not connected")).toBeTruthy();
});

test("the screen follows a theme change", async () => {
  render(<RemoteTerminal hostId={HOST} sessionId="s1" />);
  await act(() => Promise.resolve());
  const before = termHolder.current?.options.theme;
  const next =
    useLayout.getState().layout.themeId === "dracula" ? "nord" : "dracula";
  act(() => useLayout.getState().setThemeId(next));
  expect(termHolder.current?.options.theme).not.toEqual(before);
});

// ADR-0063 keeps the dialog rule: free typing stays off while Claude asks,
// and a Controller answers by its choice's key instead.
test("while Claude asks, the choices answer it and free typing is off", async () => {
  vi.mocked(remoteHostInput).mockResolvedValue();
  const asking = link({}, false, true);
  asking.sessions = asking.sessions.map((one) => ({
    ...one,
    dialogOpen: true,
    question: { options: ["Yes", "No"], text: "Run the tests?" },
  }));
  useRemoteHosts.getState().linkChanged(asking);
  render(<RemoteTerminal hostId={HOST} sessionId="s1" />);
  await act(() => Promise.resolve());
  expect(termHolder.current?.options.disableStdin).toBe(true);
  expect(screen.getByText("Run the tests?")).toBeTruthy();
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "2. No" }));
    await Promise.resolve();
  });
  expect(remoteHostInput).toHaveBeenCalledWith(HOST, "s1", "2");
  expect(screen.getByRole("button", { name: "Esc" })).toBeTruthy();
});
