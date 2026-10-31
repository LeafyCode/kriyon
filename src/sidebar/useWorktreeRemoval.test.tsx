import { act, renderHook } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";
import { removeWorktree } from "../ipc/bridge.ts";
import { type UiSession, useSessions } from "../state/sessions.ts";
import { useWorktreeRemoval } from "./useWorktreeRemoval.ts";

vi.mock("../ipc/bridge.ts", () => ({
  removeWorktree: vi.fn(() => Promise.resolve()),
}));

// Archiving stops the session's processes; this hook is not the pty layer.
const dispose = vi.fn((_id: string) => Promise.resolve());
vi.mock("../terminal/sessionHost.ts", () => ({
  disposeSession: (id: string) => dispose(id),
}));

function seed(): void {
  useSessions.setState((state) => ({
    ...state,
    projects: [
      {
        color: null,
        id: "p1",
        name: "demo",
        path: "/p1",
        parkedAt: null,
        setupCommand: null,
      },
    ],
    sessions: {
      s1: {
        archivedAt: null,
        baselineOid: null,
        claudeSessionId: null,
        createdAt: 1,
        cwd: "/p1-worktrees/feat-x",
        id: "s1",
        projectId: "p1",
        status: "idle",
        summary: "",
        title: "wt session",
        titleLocked: false,
        worktreePath: "/p1-worktrees/feat-x",
      },
    },
  }));
}

beforeEach(() => {
  vi.mocked(removeWorktree).mockReset();
  vi.mocked(removeWorktree).mockResolvedValue();
  seed();
});

test("a clean removal archives the session and never confirms", async () => {
  const { result } = renderHook(() => useWorktreeRemoval("s1"));
  await act(() => result.current.remove(false));
  expect(removeWorktree).toHaveBeenCalledWith("/p1", "/p1-worktrees/feat-x");
  expect(result.current.confirming).toBe(false);
  expect(useSessions.getState().sessions.s1?.archivedAt).not.toBeNull();
  // Its worktree is gone: a claude left running there would have no cwd.
  expect(dispose).toHaveBeenCalledWith("s1");
});

test("a refused (dirty) removal escalates to the confirm step", async () => {
  vi.mocked(removeWorktree).mockRejectedValueOnce(new Error("dirty tree"));
  const { result } = renderHook(() => useWorktreeRemoval("s1"));
  await act(() => result.current.remove(false));
  expect(result.current.confirming).toBe(true);
  expect(useSessions.getState().sessions.s1?.archivedAt).toBeNull();
});

test("a failed forced removal resets the confirm instead of archiving", async () => {
  vi.mocked(removeWorktree).mockRejectedValue(new Error("locked"));
  const { result } = renderHook(() => useWorktreeRemoval("s1"));
  await act(() => result.current.remove(false));
  expect(result.current.confirming).toBe(true);
  await act(() => result.current.remove(true));
  expect(removeWorktree).toHaveBeenLastCalledWith(
    "/p1",
    "/p1-worktrees/feat-x",
    true
  );
  expect(result.current.confirming).toBe(false);
  expect(useSessions.getState().sessions.s1?.archivedAt).toBeNull();
});

test("cancel leaves the confirm step without touching the worktree", async () => {
  vi.mocked(removeWorktree).mockRejectedValueOnce(new Error("dirty"));
  const { result } = renderHook(() => useWorktreeRemoval("s1"));
  await act(() => result.current.remove(false));
  act(() => result.current.cancel());
  expect(result.current.confirming).toBe(false);
  expect(removeWorktree).toHaveBeenCalledTimes(1);
});

test("a session without a worktree is a no-op", async () => {
  useSessions.setState((state) => ({
    ...state,
    sessions: {
      s1: { ...(state.sessions.s1 as UiSession), worktreePath: null },
    },
  }));
  const { result } = renderHook(() => useWorktreeRemoval("s1"));
  await act(() => result.current.remove(false));
  expect(removeWorktree).not.toHaveBeenCalled();
});
