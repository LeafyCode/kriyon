import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { repoStatus } = vi.hoisted(() => ({ repoStatus: vi.fn() }));
vi.mock("../ipc/bridge.ts", () => ({ repoStatus }));

import type { RepoStatus } from "../types.ts";
import {
  useRepoStatus,
  useRepoView,
  useWorktreeDirty,
} from "./useActiveSession.ts";

function status(branch: string, dirtyCount: number): RepoStatus {
  return { ahead: 0, behind: 0, branch, dirtyCount };
}

describe("useRepoStatus", () => {
  beforeEach(() => {
    repoStatus.mockReset();
  });

  it("serves a path's cached status synchronously on return, with no null flash", async () => {
    const a = status("branch-a", 1);
    const b = status("branch-b", 2);
    repoStatus.mockImplementation((path: string) =>
      Promise.resolve(path === "/repo/a" ? a : b)
    );

    const { result, rerender } = renderHook(({ path }) => useRepoStatus(path), {
      initialProps: { path: "/repo/a" },
    });

    // Cold path: resolves after the first fetch.
    await waitFor(() => expect(result.current).toEqual(a));

    rerender({ path: "/repo/b" });
    await waitFor(() => expect(result.current).toEqual(b));

    // Switching back to an already-resolved path must paint its cached status
    // immediately — no empty flash while a background revalidation runs.
    rerender({ path: "/repo/a" });
    expect(result.current).toEqual(a);
  });

  it("starts null for a never-seen path while its first fetch is in flight", () => {
    repoStatus.mockReturnValue(
      new Promise(() => {
        // never resolves — the first fetch stays in flight
      })
    );

    const { result } = renderHook(() =>
      useRepoStatus("/repo/never-seen-unique")
    );

    expect(result.current).toBeNull();
  });

  it("stays null for the empty path and never fetches", () => {
    const { result } = renderHook(() => useRepoStatus(""));

    expect(result.current).toBeNull();
    expect(repoStatus).not.toHaveBeenCalled();
  });

  it("delivers the status to every concurrent consumer of the same path", async () => {
    // Inspector + header + rail all watch the active repo at once. A shared
    // module-level resource must not let its seq-guard leave one of them blank.
    const s = status("main", 3);
    repoStatus.mockResolvedValue(s);
    const path = "/repo/concurrent-consumers";

    const one = renderHook(() => useRepoStatus(path));
    const two = renderHook(() => useRepoStatus(path));

    await waitFor(() => {
      expect(one.result.current).toEqual(s);
      expect(two.result.current).toEqual(s);
    });
  });
});

/**
 * A deferred promise plus its settlers, so a test can hold one path's fetch in
 * flight across a switch and settle it afterwards.
 */
function deferred<T>(): {
  promise: Promise<T>;
  reject: (reason: unknown) => void;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, reject, resolve };
}

/**
 * Let a rejected fetch's `onSettle` run and its state write flush. Awaiting the
 * deferred alone is not enough: the resource's `catch` handler is a separate
 * link in the microtask chain, so an assertion made straight after the reject
 * passes before the stale verdict has had its chance to land.
 */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe("useRepoView", () => {
  beforeEach(() => {
    repoStatus.mockReset();
  });

  it("ignores a cold failure that settles after the path moved on", async () => {
    // The seq-guard is per key, so the old path's rejection is still "newest"
    // for ITS key and fires onSettle — at a hook instance that has since moved
    // to a different, perfectly good repo. Without a guard the Inspector and
    // ChangesView say "Not a git repository" about a repo that is one.
    const bad = deferred<RepoStatus>();
    const good = status("main", 0);
    repoStatus.mockImplementation((path: string) =>
      path === "/repo/view-bad" ? bad.promise : Promise.resolve(good)
    );

    const { result, rerender } = renderHook(({ path }) => useRepoView(path), {
      initialProps: { path: "/repo/view-bad" },
    });

    rerender({ path: "/repo/view-good" });
    await waitFor(() => expect(result.current.status).toEqual(good));

    bad.reject(new Error("not a git repository"));
    await settle();

    expect(result.current.missing).toBe(false);
    expect(result.current.status).toEqual(good);
  });

  it("still reports a cold failure for the path it is actually on", async () => {
    repoStatus.mockRejectedValue(new Error("not a git repository"));

    const { result } = renderHook(() => useRepoView("/repo/view-really-bad"));

    await waitFor(() => expect(result.current.missing).toBe(true));
  });
});

describe("useWorktreeDirty", () => {
  beforeEach(() => {
    repoStatus.mockReset();
  });

  it("ignores a cold failure that settles after the path moved on", async () => {
    // Same seam as useRepoView: a stale rejection must not flip the new path's
    // dirty dot to "unknown" and blank the sidebar row's badge.
    const bad = deferred<RepoStatus>();
    repoStatus.mockImplementation((path: string) =>
      path === "/repo/dirty-bad"
        ? bad.promise
        : Promise.resolve(status("main", 2))
    );

    const { result, rerender } = renderHook(
      ({ path }) => useWorktreeDirty(path, "idle"),
      { initialProps: { path: "/repo/dirty-bad" } }
    );

    rerender({ path: "/repo/dirty-good" });
    await waitFor(() => expect(result.current).toBe("dirty"));

    bad.reject(new Error("not a git repository"));
    await settle();

    expect(result.current).toBe("dirty");
  });
});
