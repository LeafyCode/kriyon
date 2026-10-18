import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../ipc/bridge.ts", () => ({
  diffSessionChanges: vi.fn(),
  diffWorkingTree: vi.fn(),
  readBaseline: vi.fn(),
  readFile: vi.fn(),
  writeFile: vi.fn(),
}));
// `requestRefresh` alone is stubbed — the save trigger this suite asserts on.
// The rest of the coordinator stays real, `useRevalidateOn` above all: it is
// the protocol every revalidation test below actually drives.
vi.mock("../state/changesRefresh.ts", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  requestRefresh: vi.fn(),
}));

import {
  type BaselineContent,
  readBaseline,
  readFile,
  writeFile,
} from "../ipc/bridge.ts";
import { useChanges } from "../state/changes.ts";
import { requestRefresh } from "../state/changesRefresh.ts";
import type { FileContent } from "../types.ts";
import {
  BASELINE_REFETCH_INTERVAL_MS,
  CONFLICT_ERROR_MESSAGE,
  type FileViewerNotice,
  MISSING_FILE_ERROR_MESSAGE,
  useFileEditorSession,
} from "./useFileEditorSession.ts";

const mockedReadFile = vi.mocked(readFile);
const mockedWriteFile = vi.mocked(writeFile);
const mockedReadBaseline = vi.mocked(readBaseline);
const mockedRequestRefresh = vi.mocked(requestRefresh);

/** The wire shape Rust's `tagged_failure` actually produces for these two
 * kinds (see `file_cmd.rs`'s `write_file_sync` and `sandbox.rs`'s
 * `SandboxRoot::resolve`) — every mock
 * rejection standing in for a real backend failure below uses these, not the
 * bare human-readable constants, so the tests exercise the same
 * `commandFailure` classification production code does. */
const TAGGED_CONFLICT_ERROR = `kind:save-conflict: ${CONFLICT_ERROR_MESSAGE}`;
const TAGGED_MISSING_FILE_ERROR = `kind:file-missing: ${MISSING_FILE_ERROR_MESSAGE}`;

function content(overrides: Partial<FileContent> = {}): FileContent {
  return {
    binary: false,
    content: "a",
    lossy: false,
    mtime: 111,
    size: 1,
    truncated: false,
    ...overrides,
  };
}

/** Type-narrowing helper: seed a draft edit without an inline `c ? … : c`
 * ternary at every call site. */
function setDraft(
  setEdit: ReturnType<typeof useFileEditorSession>["setEdit"],
  draft: string
): void {
  act(() => {
    setEdit((current) => (current ? { ...current, draft } : current));
  });
}

/** Is a [File viewer notice] of this kind currently raised? Stands in for the
 * `staleOnDisk`/`missingOnDisk` booleans this hook used to return; the
 * `FileViewer` suite is what pins how several of them stack. */
function raises(
  notices: FileViewerNotice[],
  kind: FileViewerNotice["kind"]
): boolean {
  return notices.some((notice) => notice.kind === kind);
}

/** Every raised notice's kind, in render order — for the tests that care that
 * one notice is raised *instead of* another, not merely alongside it. */
function noticeKinds(notices: FileViewerNotice[]): string[] {
  return notices.map((notice) => notice.kind);
}

/** The save-failure notice, narrowed so its `message`/`canReload` are
 * readable. */
function saveErrorNotice(
  notices: FileViewerNotice[]
): Extract<FileViewerNotice, { kind: "saveError" }> | undefined {
  return notices.find(
    (notice): notice is Extract<FileViewerNotice, { kind: "saveError" }> =>
      notice.kind === "saveError"
  );
}

/** Push the clock past {@link BASELINE_REFETCH_INTERVAL_MS} so the next
 * landed refresh is allowed to refetch the gutter baseline. Only `Date` is
 * faked (see `beforeEach`), so `waitFor`'s own real timers still tick and no
 * test has to pump them by hand. */
function advanceClockPastBaselineThrottle() {
  vi.setSystemTime(Date.now() + BASELINE_REFETCH_INTERVAL_MS + 1);
}

describe("useFileEditorSession", () => {
  beforeEach(() => {
    // `Date` alone, never the timer functions: the baseline refetch throttle
    // is wall-clock, but `waitFor` needs real `setTimeout`/`setInterval` to
    // poll at all.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.clearAllMocks();
    // `bySession` too, not just `fileDrafts`: the revalidation effect keys off
    // `fetchedAt`, so a value left behind by the previous test would make an
    // identical one here look like "no refresh landed".
    useChanges.setState({ bySession: {}, dirtyFiles: {}, fileDrafts: {} });
    // Neutral default (gutter off) so every pre-existing test — none of which
    // cares about the baseline — doesn't have to stub it individually.
    // `vi.clearAllMocks()` clears call history, not a mock's implementation,
    // so this needs re-asserting every test regardless.
    mockedReadBaseline.mockResolvedValue({ content: null, state: "tracked" });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("loads a file into an editable, non-dirty session", async () => {
    mockedReadFile.mockResolvedValue(content({ content: "hello" }));

    const { result } = renderHook(() =>
      useFileEditorSession("/repo", "a.ts", vi.fn())
    );

    await waitFor(() => expect(result.current.state.status).toBe("loaded"));
    expect(result.current.edit?.draft).toBe("hello");
    expect(result.current.dirty).toBe(false);
  });

  it("saves the draft against the read-time signature and clears dirty", async () => {
    mockedReadFile.mockResolvedValue(
      content({ content: "old", mtime: 111, size: 3 })
    );
    mockedWriteFile.mockResolvedValue({ len: 3, mtime: 222 });

    const { result } = renderHook(() =>
      useFileEditorSession("/repo", "a.ts", vi.fn())
    );
    await waitFor(() => expect(result.current.edit).not.toBeNull());

    setDraft(result.current.setEdit, "new");
    expect(result.current.dirty).toBe(true);

    act(() => {
      result.current.save();
    });

    // The conflict guard always gets the exact read-time (mtime, len).
    await waitFor(() =>
      expect(mockedWriteFile).toHaveBeenCalledWith(
        "/repo",
        "a.ts",
        "new",
        111,
        3
      )
    );
    await waitFor(() => expect(result.current.dirty).toBe(false));
  });

  it("requests a Changes-view refresh (reason 'saved') after a save with a sessionId", async () => {
    mockedReadFile.mockResolvedValue(content({ content: "old" }));
    mockedWriteFile.mockResolvedValue({ len: 3, mtime: 222 });

    const { result } = renderHook(() =>
      useFileEditorSession("/repo", "a.ts", vi.fn(), "s1")
    );
    await waitFor(() => expect(result.current.edit).not.toBeNull());

    setDraft(result.current.setEdit, "new");
    act(() => {
      result.current.save();
    });

    await waitFor(() =>
      expect(mockedRequestRefresh).toHaveBeenCalledWith("s1", "saved")
    );
  });

  it("keeps a lossy (non-UTF-8) file read-only — no edit buffer", async () => {
    mockedReadFile.mockResolvedValue(content({ lossy: true }));

    const { result } = renderHook(() =>
      useFileEditorSession("/repo", "a.ts", vi.fn())
    );

    await waitFor(() => expect(result.current.state.status).toBe("loaded"));
    expect(result.current.edit).toBeNull();
  });

  it("flags a changed-on-disk save failure as a conflict", async () => {
    mockedReadFile.mockResolvedValue(content({ content: "old" }));
    mockedWriteFile.mockRejectedValue(new Error(TAGGED_CONFLICT_ERROR));

    const { result } = renderHook(() =>
      useFileEditorSession("/repo", "a.ts", vi.fn())
    );
    await waitFor(() => expect(result.current.edit).not.toBeNull());

    setDraft(result.current.setEdit, "new");
    act(() => {
      result.current.save();
    });

    // A conflict is the one save failure with a recovery action, so its
    // notice offers Reload.
    await waitFor(() =>
      expect(saveErrorNotice(result.current.notices)?.canReload).toBe(true)
    );
    // The banner shows the human-readable half, leader stripped — never the
    // raw `"kind:save-conflict: "`-tagged wire text.
    expect(saveErrorNotice(result.current.notices)?.message).toBe(
      CONFLICT_ERROR_MESSAGE
    );
  });

  it("routes a save onto a deleted file into the missing-on-disk banner, not a generic save error", async () => {
    // Spec P1.4: the save path gains the same affordance revalidation has.
    // Only `missingOnDisk` is set — leaving `saveError` up too would stack a
    // raw "path does not exist" banner above the recovery one saying the same
    // thing with a Close button.
    mockedReadFile.mockResolvedValue(content({ content: "old" }));
    mockedWriteFile.mockRejectedValue(new Error(TAGGED_MISSING_FILE_ERROR));

    const { result } = renderHook(() =>
      useFileEditorSession("/repo", "a.ts", vi.fn())
    );
    await waitFor(() => expect(result.current.edit).not.toBeNull());

    setDraft(result.current.setEdit, "new");
    act(() => {
      result.current.save();
    });

    // `toEqual`, not "contains": the point is that this is the *only* notice
    // raised — a saveError beside it would be the stacked pair this branch
    // exists to avoid.
    await waitFor(() =>
      expect(noticeKinds(result.current.notices)).toEqual(["missingOnDisk"])
    );
    // The draft is never thrown away by a failed save.
    expect(result.current.edit?.draft).toBe("new");
  });

  it("keeps an unsaved draft across an unmount — an evicted pane must not lose it", async () => {
    mockedReadFile.mockResolvedValue(
      content({ content: "old", mtime: 111, size: 3 })
    );

    const first = renderHook(() =>
      useFileEditorSession("/repo", "a.ts", vi.fn(), "s1")
    );
    await waitFor(() => expect(first.result.current.edit).not.toBeNull());
    setDraft(first.result.current.setEdit, "unsaved work");
    expect(first.result.current.dirty).toBe(true);

    // The warm-pane LRU unmounts ChangesView underneath the user: no × click,
    // so the close/switch dirty guard never gets a say.
    first.unmount();

    const second = renderHook(() =>
      useFileEditorSession("/repo", "a.ts", vi.fn(), "s1")
    );
    await waitFor(() => expect(second.result.current.edit).not.toBeNull());
    expect(second.result.current.edit?.draft).toBe("unsaved work");
    expect(second.result.current.dirty).toBe(true);
  });

  it("saves a restored draft against the signature it was first read at", async () => {
    mockedReadFile.mockResolvedValueOnce(
      content({ content: "old", mtime: 111, size: 3 })
    );
    mockedWriteFile.mockResolvedValue({ len: 3, mtime: 999 });

    const first = renderHook(() =>
      useFileEditorSession("/repo", "a.ts", vi.fn(), "s1")
    );
    await waitFor(() => expect(first.result.current.edit).not.toBeNull());
    setDraft(first.result.current.setEdit, "new");
    first.unmount();

    // `claude` rewrote the file while the pane was cold.
    mockedReadFile.mockResolvedValue(
      content({ content: "moved", mtime: 222, size: 5 })
    );
    const second = renderHook(() =>
      useFileEditorSession("/repo", "a.ts", vi.fn(), "s1")
    );
    await waitFor(() => expect(second.result.current.edit?.draft).toBe("new"));

    act(() => {
      second.result.current.save();
    });

    // The *original* (111, 3), not the file's new signature — so the Save
    // conflict guard still refuses rather than clobbering what landed on disk.
    await waitFor(() =>
      expect(mockedWriteFile).toHaveBeenCalledWith(
        "/repo",
        "a.ts",
        "new",
        111,
        3
      )
    );
  });

  it("does not resurrect a clean buffer — a cold pane reloads what is on disk", async () => {
    mockedReadFile.mockResolvedValueOnce(content({ content: "old" }));

    const first = renderHook(() =>
      useFileEditorSession("/repo", "a.ts", vi.fn(), "s1")
    );
    await waitFor(() => expect(first.result.current.edit).not.toBeNull());
    first.unmount();

    mockedReadFile.mockResolvedValue(content({ content: "rewritten" }));
    const second = renderHook(() =>
      useFileEditorSession("/repo", "a.ts", vi.fn(), "s1")
    );

    await waitFor(() => expect(second.result.current.edit).not.toBeNull());
    expect(second.result.current.edit?.draft).toBe("rewritten");
    expect(second.result.current.dirty).toBe(false);
  });

  it("does not stash a draft the user chose to discard", async () => {
    mockedReadFile.mockResolvedValue(content({ content: "old" }));

    const { result, unmount } = renderHook(() =>
      useFileEditorSession("/repo", "a.ts", vi.fn(), "s1")
    );
    await waitFor(() => expect(result.current.edit).not.toBeNull());
    setDraft(result.current.setEdit, "unsaved work");

    // × on a dirty file raises the banner; "Discard and close" answers it.
    act(() => {
      result.current.guard.closeClick();
    });
    act(() => {
      result.current.guard.discardClose();
    });
    unmount();

    expect(useChanges.getState().fileDrafts.s1).toBeUndefined();
  });

  it("forgets stashed drafts when the session is dropped", async () => {
    mockedReadFile.mockResolvedValue(content({ content: "old" }));

    const first = renderHook(() =>
      useFileEditorSession("/repo", "a.ts", vi.fn(), "s1")
    );
    await waitFor(() => expect(first.result.current.edit).not.toBeNull());
    setDraft(first.result.current.setEdit, "unsaved work");
    first.unmount();
    expect(useChanges.getState().fileDrafts.s1).toBeDefined();

    act(() => {
      useChanges.getState().dropSession("s1");
    });

    expect(useChanges.getState().fileDrafts.s1).toBeUndefined();
  });

  it("revert drops the draft back to the loaded baseline", async () => {
    mockedReadFile.mockResolvedValue(content({ content: "base" }));

    const { result } = renderHook(() =>
      useFileEditorSession("/repo", "a.ts", vi.fn())
    );
    await waitFor(() => expect(result.current.edit).not.toBeNull());

    setDraft(result.current.setEdit, "edited");
    expect(result.current.dirty).toBe(true);

    act(() => {
      result.current.revert();
    });

    expect(result.current.dirty).toBe(false);
    expect(result.current.edit?.draft).toBe("base");
  });

  it("publishes the dirty path to the store and clears it on revert", async () => {
    mockedReadFile.mockResolvedValue(content({ content: "hello" }));
    const { result } = renderHook(() =>
      useFileEditorSession("/repo", "a.ts", vi.fn(), "s1")
    );
    await waitFor(() => expect(result.current.edit).not.toBeNull());
    setDraft(result.current.setEdit, "hell");
    await waitFor(() =>
      expect(useChanges.getState().dirtyFiles.s1).toBe("a.ts")
    );
    act(() => result.current.revert());
    await waitFor(() => expect(useChanges.getState().dirtyFiles.s1).toBeNull());
  });

  it("clears the dirty path on unmount, leaving a stashed draft visible via fileDrafts", async () => {
    mockedReadFile.mockResolvedValue(content({ content: "hello" }));
    const { result, unmount } = renderHook(() =>
      useFileEditorSession("/repo", "a.ts", vi.fn(), "s1")
    );
    await waitFor(() => expect(result.current.edit).not.toBeNull());
    setDraft(result.current.setEdit, "hell");
    await waitFor(() =>
      expect(useChanges.getState().dirtyFiles.s1).toBe("a.ts")
    );

    unmount();

    expect(useChanges.getState().dirtyFiles.s1).toBeNull();
    expect(useChanges.getState().fileDrafts.s1?.["a.ts"]).toBeDefined();
  });

  // --- following the file on disk ---------------------------------------

  /** Land a refresh for `sessionId`, the signal an open file revalidates on. */
  function landRefresh(sessionId: string, fetchedAt: number) {
    act(() => {
      useChanges.setState((s) => ({
        bySession: {
          ...s.bySession,
          [sessionId]: {
            baselineLabel: "",
            collapsed: {},
            diff: null,
            fetchedAt,
            hunkHashes: {},
            status: "ready",
            totals: null,
            viewed: {},
          },
        },
      }));
    });
  }

  it("adopts the file's new content when it changes on disk and the buffer is clean", async () => {
    // The bug: nothing re-read the file after the initial load, so a file
    // Claude edited while it was open stayed frozen at the old content.
    mockedReadFile.mockResolvedValue(
      content({ content: "before", mtime: 111, size: 6 })
    );
    const { result } = renderHook(() =>
      useFileEditorSession("/repo", "a.ts", vi.fn(), "s1")
    );
    await waitFor(() => expect(result.current.edit?.draft).toBe("before"));

    mockedReadFile.mockResolvedValue(
      content({ content: "after", mtime: 222, size: 5 })
    );
    landRefresh("s1", 1000);

    await waitFor(() => expect(result.current.edit?.draft).toBe("after"));
    expect(result.current.dirty).toBe(false);
  });

  it("adopts the new on-disk signature too, so a later save is not a false conflict", async () => {
    // The second half of the same bug: the stale (mtime, len) meant Save
    // failed the conflict guard against a change the user was already seeing.
    mockedReadFile.mockResolvedValue(
      content({ content: "before", mtime: 111, size: 6 })
    );
    mockedWriteFile.mockResolvedValue({ len: 3, mtime: 333 });
    const { result } = renderHook(() =>
      useFileEditorSession("/repo", "a.ts", vi.fn(), "s1")
    );
    await waitFor(() => expect(result.current.edit?.draft).toBe("before"));

    mockedReadFile.mockResolvedValue(
      content({ content: "after", mtime: 222, size: 5 })
    );
    landRefresh("s1", 1000);
    await waitFor(() => expect(result.current.edit?.draft).toBe("after"));

    setDraft(result.current.setEdit, "mine");
    act(() => {
      result.current.save();
    });

    await waitFor(() =>
      expect(mockedWriteFile).toHaveBeenCalledWith(
        "/repo",
        "a.ts",
        "mine",
        222,
        5
      )
    );
  });

  it("never discards unsaved edits — a dirty buffer keeps the draft and is told instead", async () => {
    mockedReadFile.mockResolvedValue(
      content({ content: "before", mtime: 111, size: 6 })
    );
    const { result } = renderHook(() =>
      useFileEditorSession("/repo", "a.ts", vi.fn(), "s1")
    );
    await waitFor(() => expect(result.current.edit?.draft).toBe("before"));

    setDraft(result.current.setEdit, "my unsaved work");
    mockedReadFile.mockResolvedValue(
      content({ content: "after", mtime: 222, size: 5 })
    );
    landRefresh("s1", 1000);

    await waitFor(() =>
      expect(raises(result.current.notices, "staleOnDisk")).toBe(true)
    );
    expect(result.current.edit?.draft).toBe("my unsaved work");
    expect(result.current.dirty).toBe(true);
  });

  it("clears the stale-on-disk flag once the user reloads", async () => {
    mockedReadFile.mockResolvedValue(
      content({ content: "before", mtime: 111, size: 6 })
    );
    const { result } = renderHook(() =>
      useFileEditorSession("/repo", "a.ts", vi.fn(), "s1")
    );
    await waitFor(() => expect(result.current.edit?.draft).toBe("before"));

    setDraft(result.current.setEdit, "mine");
    mockedReadFile.mockResolvedValue(
      content({ content: "after", mtime: 222, size: 5 })
    );
    landRefresh("s1", 1000);
    await waitFor(() =>
      expect(raises(result.current.notices, "staleOnDisk")).toBe(true)
    );

    act(() => {
      result.current.reload();
    });

    await waitFor(() => expect(result.current.edit?.draft).toBe("after"));
    expect(raises(result.current.notices, "staleOnDisk")).toBe(false);
  });

  it("does not churn the editor when a refresh lands but the file did not change", async () => {
    // Refreshes land once or twice a second during a busy turn. Re-seeding
    // the editor each time would fight the cursor for no reason.
    mockedReadFile.mockResolvedValue(
      content({ content: "same", mtime: 111, size: 4 })
    );
    const { result } = renderHook(() =>
      useFileEditorSession("/repo", "a.ts", vi.fn(), "s1")
    );
    await waitFor(() => expect(result.current.edit?.draft).toBe("same"));
    const before = result.current.edit;

    landRefresh("s1", 1000);
    await waitFor(() => expect(mockedReadFile).toHaveBeenCalledTimes(2));

    expect(result.current.edit).toBe(before);
    expect(raises(result.current.notices, "staleOnDisk")).toBe(false);
  });

  it("does not flag staleOnDisk when revalidation lands after its own save", async () => {
    mockedReadFile.mockResolvedValue(
      content({ content: "old", mtime: 111, size: 3 })
    );
    mockedWriteFile.mockResolvedValue({ len: 3, mtime: 222 });

    const { result } = renderHook(() =>
      useFileEditorSession("/repo", "a.ts", vi.fn(), "s1")
    );
    await waitFor(() => expect(result.current.edit).not.toBeNull());

    setDraft(result.current.setEdit, "new");
    act(() => {
      result.current.save();
    });
    await waitFor(() => expect(result.current.dirty).toBe(false));

    // User keeps typing after the save resolved.
    setDraft(result.current.setEdit, "newer");

    // The save's own requestRefresh lands: revalidation re-reads the file and
    // sees exactly the signature the save just wrote.
    mockedReadFile.mockResolvedValue(
      content({ content: "new", mtime: 222, size: 3 })
    );
    landRefresh("s1", 1000);

    await waitFor(() => expect(mockedReadFile).toHaveBeenCalledTimes(2));
    expect(raises(result.current.notices, "staleOnDisk")).toBe(false);
  });

  it("does not revalidate without a session id", async () => {
    // A bare unit render (no session) has no refresh signal to follow.
    mockedReadFile.mockResolvedValue(content({ content: "x" }));
    renderHook(() => useFileEditorSession("/repo", "a.ts", vi.fn()));
    await waitFor(() => expect(mockedReadFile).toHaveBeenCalledTimes(1));

    landRefresh("s1", 1000);
    await Promise.resolve();

    expect(mockedReadFile).toHaveBeenCalledTimes(1);
  });

  // --- deleted-on-disk ----------------------------------------------------

  it("flags missingOnDisk when revalidation can no longer read the file", async () => {
    mockedReadFile.mockResolvedValue(content({ content: "hello" }));
    const { result } = renderHook(() =>
      useFileEditorSession("/repo", "a.ts", vi.fn(), "s1")
    );
    await waitFor(() => expect(result.current.edit).not.toBeNull());
    landRefresh("s1", 1);

    mockedReadFile.mockRejectedValue(new Error(TAGGED_MISSING_FILE_ERROR));
    landRefresh("s1", 2);

    await waitFor(() =>
      expect(raises(result.current.notices, "missingOnDisk")).toBe(true)
    );
    // the buffer is untouched
    expect(result.current.edit?.draft).toBe("hello");
  });

  it("leaves missingOnDisk alone when revalidation fails for some other reason", async () => {
    // A permission error, an IPC hiccup, or a cwd that stopped being a repo
    // are not "this file was deleted" — the original design silently retries
    // them on the next refresh, and saying "deleted or moved" instead is a
    // confident lie about a file that is still right there.
    mockedReadFile.mockResolvedValue(content({ content: "hello" }));
    const { result } = renderHook(() =>
      useFileEditorSession("/repo", "a.ts", vi.fn(), "s1")
    );
    await waitFor(() => expect(result.current.edit).not.toBeNull());

    mockedReadFile.mockRejectedValue(new Error("permission denied"));
    landRefresh("s1", 1000);

    await waitFor(() => expect(mockedReadFile).toHaveBeenCalledTimes(2));
    // Let the rejection's handler run before asserting it changed nothing.
    await act(() => Promise.resolve());
    expect(raises(result.current.notices, "missingOnDisk")).toBe(false);
    expect(result.current.edit?.draft).toBe("hello");
  });

  it("routes a reload of a since-deleted file into the missing banner", async () => {
    // The stale-then-deleted dead end: the user is looking at the "changed on
    // disk" banner, clicks Reload, and the file is gone. Before this the raw
    // "path does not exist" landed in `saveError` — a second banner, stacked
    // over the stale one, with no recovery action on either.
    mockedReadFile.mockResolvedValue(
      content({ content: "before", mtime: 111, size: 6 })
    );
    const { result } = renderHook(() =>
      useFileEditorSession("/repo", "a.ts", vi.fn(), "s1")
    );
    await waitFor(() => expect(result.current.edit?.draft).toBe("before"));

    setDraft(result.current.setEdit, "mine");
    mockedReadFile.mockResolvedValue(
      content({ content: "after", mtime: 222, size: 5 })
    );
    landRefresh("s1", 1000);
    await waitFor(() =>
      expect(raises(result.current.notices, "staleOnDisk")).toBe(true)
    );

    mockedReadFile.mockRejectedValue(new Error(TAGGED_MISSING_FILE_ERROR));
    act(() => {
      result.current.reload();
    });

    // Again the *only* notice: the reload branch clears both the stale flag
    // it came from and any save error, rather than stacking a third banner.
    await waitFor(() =>
      expect(noticeKinds(result.current.notices)).toEqual(["missingOnDisk"])
    );
    expect(result.current.edit?.draft).toBe("mine");
  });

  it("clears missingOnDisk once a save succeeds", async () => {
    // The file came back (restored externally, or recreated by the user's own
    // tooling) and the write landed — the deleted-file banner is a lie now.
    mockedReadFile.mockResolvedValue(content({ content: "old" }));
    mockedWriteFile.mockRejectedValueOnce(new Error(TAGGED_MISSING_FILE_ERROR));
    mockedWriteFile.mockResolvedValue({ len: 3, mtime: 222 });

    const { result } = renderHook(() =>
      useFileEditorSession("/repo", "a.ts", vi.fn())
    );
    await waitFor(() => expect(result.current.edit).not.toBeNull());

    setDraft(result.current.setEdit, "new");
    act(() => {
      result.current.save();
    });
    await waitFor(() =>
      expect(raises(result.current.notices, "missingOnDisk")).toBe(true)
    );

    act(() => {
      result.current.save();
    });

    await waitFor(() =>
      expect(raises(result.current.notices, "missingOnDisk")).toBe(false)
    );
  });

  it("clears missingOnDisk when a later revalidation succeeds", async () => {
    mockedReadFile.mockResolvedValue(content({ content: "hello" }));
    const { result } = renderHook(() =>
      useFileEditorSession("/repo", "a.ts", vi.fn(), "s1")
    );
    await waitFor(() => expect(result.current.edit).not.toBeNull());
    landRefresh("s1", 1);

    mockedReadFile.mockRejectedValue(new Error(TAGGED_MISSING_FILE_ERROR));
    landRefresh("s1", 2);
    await waitFor(() =>
      expect(raises(result.current.notices, "missingOnDisk")).toBe(true)
    );

    mockedReadFile.mockResolvedValue(content({ content: "hello", mtime: 333 }));
    landRefresh("s1", 3);

    await waitFor(() =>
      expect(raises(result.current.notices, "missingOnDisk")).toBe(false)
    );
  });

  // --- git-gutter baseline -------------------------------------------------

  it("fetches the git baseline for the open file and survives fetch failure", async () => {
    mockedReadFile.mockResolvedValue(content({ content: "now" }));
    mockedReadBaseline.mockResolvedValue({ content: "was", state: "tracked" });
    const { result } = renderHook(() =>
      useFileEditorSession("/repo", "a.ts", vi.fn(), "s1")
    );
    await waitFor(() => expect(result.current.baseline).toBe("was"));
  });

  it("leaves the gutter off for an untracked file rather than marking every line added", async () => {
    // VSCode's dirty-diff decorations exist only for tracked files, and the
    // reason is not taste: an untracked file has EVERY line changed, so one
    // marker per changed line is one DOM element per line of the file —
    // synchronously, on the main thread. A 1 MiB file of short lines froze the
    // window. There is also nothing to say: "all of it is new" is already what
    // an untracked file being untracked means.
    mockedReadFile.mockResolvedValue(content({ content: "now" }));
    mockedReadBaseline.mockResolvedValue({ state: "untracked" });
    const { result } = renderHook(() =>
      useFileEditorSession("/repo", "a.ts", vi.fn(), "s1")
    );
    await waitFor(() => expect(result.current.state.status).toBe("loaded"));
    expect(result.current.baseline).toBeUndefined();
  });

  it("leaves the gutter off (undefined baseline) for a tracked file with no showable HEAD blob", async () => {
    mockedReadFile.mockResolvedValue(content({ content: "now" }));
    mockedReadBaseline.mockResolvedValue({ content: null, state: "tracked" });
    const { result } = renderHook(() =>
      useFileEditorSession("/repo", "a.ts", vi.fn(), "s1")
    );
    await waitFor(() => expect(result.current.state.status).toBe("loaded"));
    expect(result.current.baseline).toBeUndefined();
  });

  it("leaves the gutter off (not all-added) for a session cwd that is not a git repo", async () => {
    // The All-files browser works in any folder, git or not. Collapsing
    // "no repo" into "untracked" gave every file opened in a non-git session
    // a confidently wrong solid-green gutter; no baseline means no gutter.
    mockedReadFile.mockResolvedValue(content({ content: "now" }));
    mockedReadBaseline.mockResolvedValue({ state: "notARepo" });
    const { result } = renderHook(() =>
      useFileEditorSession("/plain", "a.ts", vi.fn(), "s1")
    );
    await waitFor(() => expect(result.current.state.status).toBe("loaded"));
    expect(result.current.baseline).toBeUndefined();
  });

  it("leaves the gutter off and the file still loaded when the baseline fetch itself rejects", async () => {
    mockedReadFile.mockResolvedValue(content({ content: "now" }));
    mockedReadBaseline.mockRejectedValue(new Error("git show failed"));
    const { result } = renderHook(() =>
      useFileEditorSession("/repo", "a.ts", vi.fn(), "s1")
    );
    await waitFor(() => expect(result.current.state.status).toBe("loaded"));
    expect(result.current.baseline).toBeUndefined();
  });

  it("re-fetches the baseline on a revalidation refresh, alongside the content", async () => {
    mockedReadFile.mockResolvedValue(content({ content: "before" }));
    mockedReadBaseline.mockResolvedValue({
      content: "head-a",
      state: "tracked",
    });
    const { result } = renderHook(() =>
      useFileEditorSession("/repo", "a.ts", vi.fn(), "s1")
    );
    await waitFor(() => expect(result.current.baseline).toBe("head-a"));

    mockedReadFile.mockResolvedValue(content({ content: "after" }));
    mockedReadBaseline.mockResolvedValue({
      content: "head-b",
      state: "tracked",
    });
    // The open's own fetch just ran, so this refresh is inside the refetch
    // window until the clock moves.
    advanceClockPastBaselineThrottle();
    landRefresh("s1", 1000);

    await waitFor(() => expect(result.current.baseline).toBe("head-b"));
  });

  it("re-fetches the baseline even while the buffer is flagged stale on disk", async () => {
    // The state where a truthful gutter matters most — a dirty draft beside a
    // file that moved — is exactly the one the content-revalidation gate used
    // to freeze the baseline in, so a commit landing under the user left the
    // gutter painting a HEAD that no longer existed.
    mockedReadFile.mockResolvedValue(
      content({ content: "before", mtime: 111, size: 6 })
    );
    mockedReadBaseline.mockResolvedValue({
      content: "head-a",
      state: "tracked",
    });
    const { result } = renderHook(() =>
      useFileEditorSession("/repo", "a.ts", vi.fn(), "s1")
    );
    await waitFor(() => expect(result.current.baseline).toBe("head-a"));

    setDraft(result.current.setEdit, "mine");
    mockedReadFile.mockResolvedValue(
      content({ content: "after", mtime: 222, size: 5 })
    );
    landRefresh("s1", 1000);
    await waitFor(() =>
      expect(raises(result.current.notices, "staleOnDisk")).toBe(true)
    );

    mockedReadBaseline.mockResolvedValue({
      content: "head-b",
      state: "tracked",
    });
    advanceClockPastBaselineThrottle();
    landRefresh("s1", 2000);

    await waitFor(() => expect(result.current.baseline).toBe("head-b"));
  });

  it("throttles the baseline refetch so a burst of refreshes is not a burst of git processes", async () => {
    mockedReadFile.mockResolvedValue(content({ content: "now" }));
    mockedReadBaseline.mockResolvedValue({
      content: "head-a",
      state: "tracked",
    });
    const { result } = renderHook(() =>
      useFileEditorSession("/repo", "a.ts", vi.fn(), "s1")
    );
    await waitFor(() => expect(result.current.baseline).toBe("head-a"));
    expect(mockedReadBaseline).toHaveBeenCalledTimes(1);

    // Two refreshes inside the window (a busy turn's cadence) buy one fetch
    // between them — the one the mount already did.
    landRefresh("s1", 1000);
    landRefresh("s1", 1001);
    await waitFor(() => expect(mockedReadFile).toHaveBeenCalledTimes(3));
    expect(mockedReadBaseline).toHaveBeenCalledTimes(1);

    advanceClockPastBaselineThrottle();
    landRefresh("s1", 2000);
    await waitFor(() => expect(mockedReadBaseline).toHaveBeenCalledTimes(2));
  });

  it("ignores a slow baseline response a newer fetch has already superseded", async () => {
    mockedReadFile.mockResolvedValue(content({ content: "now" }));
    let resolveFirst: (value: BaselineContent) => void = () => {
      // Replaced synchronously by the promise below, before anything calls it.
    };
    mockedReadBaseline.mockImplementationOnce(
      () =>
        new Promise<BaselineContent>((resolve) => {
          resolveFirst = resolve;
        })
    );
    const { result } = renderHook(() =>
      useFileEditorSession("/repo", "a.ts", vi.fn(), "s1")
    );
    await waitFor(() => expect(result.current.state.status).toBe("loaded"));

    mockedReadBaseline.mockResolvedValue({
      content: "head-b",
      state: "tracked",
    });
    advanceClockPastBaselineThrottle();
    landRefresh("s1", 1000);
    await waitFor(() => expect(result.current.baseline).toBe("head-b"));

    // The mount's fetch finally answers, with the older HEAD.
    await act(async () => {
      resolveFirst({ content: "head-a", state: "tracked" });
      await Promise.resolve();
    });

    expect(result.current.baseline).toBe("head-b");
  });

  it("normalizes the gutter baseline, so a CRLF repo is not a full-file diff", async () => {
    // The draft buffer is LF (CodeMirror drops \r on doc creation), so a CRLF
    // HEAD blob compared against it marks every single line modified.
    mockedReadFile.mockResolvedValue(content({ content: "a\r\nb" }));
    mockedReadBaseline.mockResolvedValue({
      content: "a\r\nb",
      state: "tracked",
    });
    const { result } = renderHook(() =>
      useFileEditorSession("/repo", "a.ts", vi.fn(), "s1")
    );
    await waitFor(() => expect(result.current.baseline).toBe("a\nb"));
    expect(result.current.edit?.draft).toBe("a\nb");
  });

  // --- CRLF line endings ---------------------------------------------------

  it("opens a CRLF file clean instead of instantly dirty", async () => {
    // CodeMirror splits on /\r\n?|\n/ and keeps no \r, so the editor's value
    // echo made `draft` LF while `baseline` stayed CRLF: the dirty dot lit up,
    // the close guard blocked, and the gutter painted the whole file modified,
    // all with zero user edits.
    mockedReadFile.mockResolvedValue(
      content({ content: "a\r\nb\r\n", size: 6 })
    );
    const { result } = renderHook(() =>
      useFileEditorSession("/repo", "a.ts", vi.fn())
    );

    await waitFor(() => expect(result.current.edit).not.toBeNull());
    expect(result.current.edit?.draft).toBe("a\nb\n");
    expect(result.current.edit?.baseline).toBe("a\nb\n");
    expect(result.current.dirty).toBe(false);
  });

  it("writes a CRLF file back with CRLF endings, not a silent LF rewrite", async () => {
    mockedReadFile.mockResolvedValue(
      content({ content: "a\r\nb\r\n", mtime: 111, size: 6 })
    );
    mockedWriteFile.mockResolvedValue({ len: 9, mtime: 222 });

    const { result } = renderHook(() =>
      useFileEditorSession("/repo", "a.ts", vi.fn())
    );
    await waitFor(() => expect(result.current.edit).not.toBeNull());

    setDraft(result.current.setEdit, "a\nb\nc\n");
    act(() => {
      result.current.save();
    });

    await waitFor(() =>
      expect(mockedWriteFile).toHaveBeenCalledWith(
        "/repo",
        "a.ts",
        "a\r\nb\r\nc\r\n",
        111,
        6
      )
    );
    // The post-save baseline is the LF buffer, so the editor does not come
    // back dirty against its own save.
    await waitFor(() => expect(result.current.dirty).toBe(false));
    expect(result.current.edit?.baseline).toBe("a\nb\nc\n");
  });

  it("leaves an LF file's bytes exactly as typed", async () => {
    mockedReadFile.mockResolvedValue(
      content({ content: "a\nb\n", mtime: 111, size: 4 })
    );
    mockedWriteFile.mockResolvedValue({ len: 6, mtime: 222 });

    const { result } = renderHook(() =>
      useFileEditorSession("/repo", "a.ts", vi.fn())
    );
    await waitFor(() => expect(result.current.edit).not.toBeNull());

    setDraft(result.current.setEdit, "a\nb\nc\n");
    act(() => {
      result.current.save();
    });

    await waitFor(() =>
      expect(mockedWriteFile).toHaveBeenCalledWith(
        "/repo",
        "a.ts",
        "a\nb\nc\n",
        111,
        4
      )
    );
  });

  it("saves a mostly-LF file with one stray CRLF as LF", async () => {
    // Detecting "any CRLF at all" would rewrite every line of a
    // predominantly-LF file to CRLF on its first save — the same silent
    // whole-file rewrite this whole change exists to stop, pointed the other
    // way. The majority wins instead.
    mockedReadFile.mockResolvedValue(
      content({ content: "a\nb\r\nc\nd\n", mtime: 111, size: 9 })
    );
    mockedWriteFile.mockResolvedValue({ len: 9, mtime: 222 });

    const { result } = renderHook(() =>
      useFileEditorSession("/repo", "a.ts", vi.fn())
    );
    await waitFor(() => expect(result.current.edit).not.toBeNull());
    expect(result.current.dirty).toBe(false);

    setDraft(result.current.setEdit, "a\nb\nc\nd\ne\n");
    act(() => {
      result.current.save();
    });

    await waitFor(() =>
      expect(mockedWriteFile).toHaveBeenCalledWith(
        "/repo",
        "a.ts",
        "a\nb\nc\nd\ne\n",
        111,
        9
      )
    );
  });

  it("saves a mostly-CRLF file with one stray LF as CRLF", async () => {
    mockedReadFile.mockResolvedValue(
      content({ content: "a\r\nb\nc\r\nd\r\n", mtime: 111, size: 12 })
    );
    mockedWriteFile.mockResolvedValue({ len: 15, mtime: 222 });

    const { result } = renderHook(() =>
      useFileEditorSession("/repo", "a.ts", vi.fn())
    );
    await waitFor(() => expect(result.current.edit).not.toBeNull());

    setDraft(result.current.setEdit, "a\nb\nc\nd\ne\n");
    act(() => {
      result.current.save();
    });

    await waitFor(() =>
      expect(mockedWriteFile).toHaveBeenCalledWith(
        "/repo",
        "a.ts",
        "a\r\nb\r\nc\r\nd\r\ne\r\n",
        111,
        12
      )
    );
  });

  it("carries a CRLF file's line endings through a stashed draft", async () => {
    // The [Warm pane] LRU evicts the pane mid-edit; the restored draft must
    // still save back as CRLF rather than quietly converting the file.
    mockedReadFile.mockResolvedValue(
      content({ content: "a\r\nb\r\n", mtime: 111, size: 6 })
    );
    mockedWriteFile.mockResolvedValue({ len: 9, mtime: 222 });

    const first = renderHook(() =>
      useFileEditorSession("/repo", "a.ts", vi.fn(), "s1")
    );
    await waitFor(() => expect(first.result.current.edit).not.toBeNull());
    setDraft(first.result.current.setEdit, "a\nb\nc\n");
    first.unmount();

    const second = renderHook(() =>
      useFileEditorSession("/repo", "a.ts", vi.fn(), "s1")
    );
    await waitFor(() =>
      expect(second.result.current.edit?.draft).toBe("a\nb\nc\n")
    );
    act(() => {
      second.result.current.save();
    });

    await waitFor(() =>
      expect(mockedWriteFile).toHaveBeenCalledWith(
        "/repo",
        "a.ts",
        "a\r\nb\r\nc\r\n",
        111,
        6
      )
    );
  });
});

describe("MISSING_FILE_ERROR_MESSAGE", () => {
  it("pins the Rust missing-path wording", () => {
    // Must be byte-identical to file_cmd.rs's WRITE_MISSING_ERROR.
    expect(MISSING_FILE_ERROR_MESSAGE).toBe("path does not exist");
  });
});

describe("CONFLICT_ERROR_MESSAGE", () => {
  it("pins the Rust write-conflict wording", () => {
    // Must be byte-identical to file_cmd.rs's WRITE_CONFLICT_ERROR.
    expect(CONFLICT_ERROR_MESSAGE).toBe(
      "file changed on disk since it was opened"
    );
  });
});
