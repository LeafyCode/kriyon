import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";

vi.mock("../ipc/bridge.ts", () => ({
  blameFile: vi.fn(),
  readSessionBaseline: vi.fn(),
}));

import { blameFile, readSessionBaseline } from "../ipc/bridge.ts";
import { useChanges } from "../state/changes.ts";
import { type UiSession, useSessions } from "../state/sessions.ts";
import type { FileBlame } from "../types.ts";
import { useGitAnnotations } from "./useGitAnnotations.ts";

const mockedBlame = vi.mocked(blameFile);
const mockedSession = vi.mocked(readSessionBaseline);

const blame: FileBlame = {
  commits: [
    {
      author: "Ada",
      authorTime: 1,
      sha: "1".repeat(40),
      summary: "s",
      uncommitted: false,
    },
  ],
  lines: [0],
};

function session(baselineOid: string | null): UiSession {
  return {
    archivedAt: null,
    baselineOid,
    claudeSessionId: null,
    createdAt: 1,
    cwd: "/repo",
    id: "s1",
    projectId: "default",
    status: "idle",
    summary: "",
    title: "s1",
    titleLocked: false,
    worktreePath: null,
  } as UiSession;
}

beforeEach(() => {
  mockedBlame.mockReset().mockResolvedValue(blame);
  mockedSession
    .mockReset()
    .mockResolvedValue({ content: "start\r\n", state: "tracked" });
  useSessions.setState({ sessions: { s1: session("cafe") } });
  useChanges.setState({ bySession: {} });
});

test("fetches the file's session-start text and its blame", async () => {
  const { result } = renderHook(() => useGitAnnotations("/repo", "a.ts", "s1"));
  await waitFor(() => expect(result.current.blame).toBe(blame));
  // LF-normalized, like every other text the editor diffs against.
  expect(result.current.sessionStart).toBe("start\n");
  expect(mockedSession).toHaveBeenCalledWith("/repo", "cafe", "a.ts");
  expect(mockedBlame).toHaveBeenCalledWith("/repo", "a.ts");
});

test("a file the session created compares against nothing, so every line is new", async () => {
  mockedSession.mockResolvedValue({ state: "untracked" });
  const { result } = renderHook(() =>
    useGitAnnotations("/repo", "new.ts", "s1")
  );
  await waitFor(() => expect(result.current.sessionStart).toBe(""));
});

test("no session snapshot, no session highlight", async () => {
  useSessions.setState({ sessions: { s1: session(null) } });
  const { result } = renderHook(() => useGitAnnotations("/repo", "a.ts", "s1"));
  await waitFor(() => expect(result.current.blame).toBe(blame));
  expect(result.current.sessionStart).toBeUndefined();
  expect(mockedSession).not.toHaveBeenCalled();
});

test("a failed fetch just leaves the annotation off", async () => {
  mockedBlame.mockRejectedValue(new Error("git broke"));
  mockedSession.mockRejectedValue(new Error("git broke"));
  const { result } = renderHook(() => useGitAnnotations("/repo", "a.ts", "s1"));
  await act(async () => {
    await Promise.resolve();
  });
  expect(result.current.blame).toBeUndefined();
  expect(result.current.sessionStart).toBeUndefined();
});

test("re-fetches blame after a refresh lands (a save or a commit moves it)", async () => {
  const { result } = renderHook(() => useGitAnnotations("/repo", "a.ts", "s1"));
  await waitFor(() => expect(result.current.blame).toBe(blame));
  mockedBlame.mockClear();
  // Past the refetch floor, so the refresh isn't throttled away.
  const later = Date.now() + 5000;
  const clock = vi.spyOn(Date, "now").mockReturnValue(later);

  act(() => {
    useChanges.setState({
      bySession: {
        s1: {
          baselineLabel: "",
          collapsed: {},
          diff: null,
          fetchedAt: later,
          hunkHashes: {},
          status: "ready",
          totals: null,
          viewed: {},
        },
      },
    });
  });

  await waitFor(() => expect(mockedBlame).toHaveBeenCalledTimes(1));
  clock.mockRestore();
});

test("a slow answer for a previous file is dropped", async () => {
  let answerOld: (b: FileBlame) => void = () => undefined;
  mockedBlame.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        answerOld = resolve;
      })
  );
  const { result, rerender } = renderHook(
    ({ path }) => useGitAnnotations("/repo", path, "s1"),
    { initialProps: { path: "old.ts" } }
  );
  rerender({ path: "new.ts" });
  await waitFor(() => expect(result.current.blame).toBe(blame));
  await act(async () => {
    answerOld({ commits: [], lines: [] });
    await Promise.resolve();
  });
  expect(result.current.blame).toBe(blame);
});

test("blame waits while there are unsaved edits", async () => {
  const { result, rerender } = renderHook(
    ({ dirty }) => useGitAnnotations("/repo", "a.ts", "s1", dirty),
    { initialProps: { dirty: false } }
  );
  await waitFor(() => expect(result.current.blame).toBe(blame));
  rerender({ dirty: true });
  expect(result.current.blame).toBeUndefined();
  rerender({ dirty: false });
  expect(result.current.blame).toBe(blame);
});
