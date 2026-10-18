import { useEffect, useState } from "react";
import { repoStatus } from "../ipc/bridge.ts";
import type { ProjectRow, RepoStatus, SessionStatus } from "../types.ts";
import { sessionWorkingDir, type UiSession, useSessions } from "./sessions.ts";
import { createSwrResource } from "./swrResource.ts";

/**
 * Keyed [SWR resource] over git status, so switching to a session whose status
 * was already fetched paints it immediately instead of flashing the Changes
 * panel empty while the fresh status loads.
 */
const repoStatusResource = createSwrResource<RepoStatus>();

/**
 * What git can say about a working directory.
 *
 * `status === null` is deliberately NOT "not a repository": it is also every
 * moment before the first fetch settles, which is when a surface would paint.
 * Reading it as absence made "Not a git repository" flash on a perfectly good
 * repo. `missing` is the positive signal — the resource's cold failure, i.e.
 * `git status` threw and nothing was ever cached for this path — so a surface
 * can wait to be sure before saying so.
 */
export interface RepoView {
  missing: boolean;
  status: RepoStatus | null;
}

/**
 * Fetch git status for a path, serving the last-known status while it
 * revalidates, and reporting whether git disowns the directory outright.
 */
export function useRepoView(path: string): RepoView {
  const [status, setStatus] = useState<RepoStatus | null>(
    () => repoStatusResource.peek(path) ?? null
  );
  const [missing, setMissing] = useState(false);
  const [trackedPath, setTrackedPath] = useState(path);
  // Reset DURING render (not in an effect) when the path changes: the Inspector,
  // rail, and header are not keyed per session, so their hook instance persists
  // across a switch. A post-paint reset would let them paint the previous
  // session's status for one frame before correcting — this hook exists to kill
  // exactly that flash. The last-known status for the new path paints instantly.
  if (path !== trackedPath) {
    setTrackedPath(path);
    setStatus(repoStatusResource.peek(path) ?? null);
    // A verdict about the old path must never outlive it.
    setMissing(false);
  }
  useEffect(() => {
    if (path === "") {
      return;
    }
    // Subscribe so EVERY concurrent consumer of this path (Inspector + header +
    // rail) receives the fetched status: the shared resource's seq-guard gates
    // only the cache write, not delivery, so no consumer is left blank by losing
    // the race. Unsubscribing on cleanup replaces the old cancelled-flag guard.
    const unsubscribe = repoStatusResource.subscribe(path, (value) => {
      setStatus(value);
      setMissing(false);
    });
    // The seq-guard is per KEY, so the old path's fetch is still the newest for
    // its own key and fires `onSettle` even after this hook has moved on. The
    // render-phase reset above already cleared the old verdict; without this
    // flag the stale rejection would write it straight back, and the Inspector
    // and Changes view would say "Not a git repository" about a repo that is
    // one. Unsubscribing cannot cover it — that gates delivery, not settlement.
    let current = true;
    repoStatusResource.revalidate(path, () => repoStatus(path), {
      onSettle: (outcome) => {
        if (current) {
          setMissing(outcome.coldFailure);
        }
      },
    });
    return () => {
      current = false;
      unsubscribe();
    };
  }, [path]);
  return { missing, status };
}

/** {@link useRepoView}'s status alone, for the surfaces that only render it. */
export function useRepoStatus(path: string): RepoStatus | null {
  return useRepoView(path).status;
}

/**
 * Whether the working tree at `path` has uncommitted changes — `"unknown"`
 * until the first check settles, or when `repoStatus` cannot determine it
 * (e.g. `path` is not a git repo — nothing in this app requires one).
 * Distinguishing "unknown" from "clean" matters to callers like the
 * files-touched badge: they gate on a positively-known clean tree, and must
 * not read "we don't know" as "there's nothing to show".
 */
export type DirtyStatus = "clean" | "dirty" | "unknown";

function toDirtyStatus(value: RepoStatus | undefined): DirtyStatus {
  if (!value) {
    return "unknown";
  }
  return value.dirtyCount > 0 ? "dirty" : "clean";
}

/**
 * Whether the working tree at `path` has uncommitted changes — drives the
 * sidebar row's worktree dirty dot and its files-touched badge. Shares
 * {@link useRepoStatus}'s cache, but revalidates on the session's status
 * transitions instead of a polling loop: the check refreshes exactly when
 * the session stops/starts/waits (the moments the user looks at it), so a
 * busy sidebar never generates a git-status storm. `path` is "" for an
 * unresolved location — the hook is then inert.
 *
 * `repoStatusResource.subscribe` only fires on a *successful* revalidation
 * (see its doc comment — a failed refetch notifies no one), so a `path` that
 * always errors would otherwise leave `dirty` stuck at its initial value
 * forever. The `onSettle` handler catches exactly that cold-failure case and
 * flips the state to `"unknown"` directly, without touching `swrResource`.
 */
export function useWorktreeDirty(
  path: string,
  status: SessionStatus
): DirtyStatus {
  const [dirty, setDirty] = useState<DirtyStatus>(() =>
    toDirtyStatus(repoStatusResource.peek(path))
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: `status` is a deliberate extra dep — each session transition re-checks the tree, replacing a polling loop.
  useEffect(() => {
    if (path === "") {
      return;
    }
    const unsubscribe = repoStatusResource.subscribe(path, (value) =>
      setDirty(toDirtyStatus(value))
    );
    // Same per-key settlement gap {@link useRepoView} guards: a rejection for
    // the path this row used to watch must not blank the dirty dot of the one
    // it watches now.
    let current = true;
    repoStatusResource.revalidate(path, () => repoStatus(path), {
      onSettle: (outcome) => {
        if (current && outcome.coldFailure) {
          setDirty("unknown");
        }
      },
    });
    return () => {
      current = false;
      unsubscribe();
    };
  }, [path, status]);
  return dirty;
}

export interface ActiveSession {
  project: ProjectRow | undefined;
  repoPath: string;
  session: UiSession | undefined;
}

/** The active session plus the project it belongs to. */
export function useActiveSession(): ActiveSession {
  const activeSessionId = useSessions((state) => state.activeSessionId);
  const session = useSessions((state) =>
    activeSessionId ? state.sessions[activeSessionId] : undefined
  );
  const project = useSessions((state) =>
    session
      ? state.projects.find((candidate) => candidate.id === session.projectId)
      : undefined
  );
  return { project, repoPath: sessionWorkingDir(session), session };
}
