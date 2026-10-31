import { create } from "zustand";
import type {
  HooksOffScope,
  ProjectRow,
  SessionStanding,
  SessionStatus,
  StandingState,
} from "../types.ts";
import { isPutAway, type UiSession } from "./sessions.ts";

/**
 * How long a session's watcher may go unheard-from before the command center
 * stops trusting its last concrete state and shows `unknown` instead. A dead or
 * quiet watcher is reported honestly, never as its possibly-stale state.
 *
 * Sized at ~3× the backend heartbeat interval (the 2s ticker in `lib.rs`), so a
 * healthy session tolerates a couple of missed beats before going `unknown`.
 * Keep this comfortably above that interval if the ticker cadence changes.
 */
export const STALE_AFTER_MS = 6000;

/**
 * Present a concrete {@link SessionStatus} as the standing the command center
 * renders, before the liveness overlay is applied (see {@link standingState}).
 */
export function mapStatus(
  status: SessionStatus
): Exclude<StandingState, "unknown"> {
  switch (status) {
    case "running":
      return "running";
    case "waiting":
      return "awaiting_input";
    case "done":
    case "error":
      return "changed";
    default:
      return "idle";
  }
}

/**
 * The standing for a session, gated by watcher liveness: `unknown` when the
 * watcher has never been seen or its last-seen time differs from now by more
 * than `staleAfterMs` in either direction, otherwise the mapped concrete status.
 *
 * The future-side guard matters: liveness keeps the maximum last-seen value, so
 * a clock jump forward would pin it ahead of now and, once the clock corrects,
 * keep a since-dead watcher showing a confident state forever — the one
 * "confident wrong state" the command center must never render. A stamp dated
 * past the window in the future is as untrustworthy as a stale one. The window
 * tolerance still absorbs the small skew of an event stamped a beat after the
 * render captured `nowMs`.
 */
export function standingState(
  status: SessionStatus,
  lastSeenMs: number | undefined,
  nowMs: number,
  staleAfterMs = STALE_AFTER_MS
): StandingState {
  if (lastSeenMs === undefined || Math.abs(nowMs - lastSeenMs) > staleAfterMs) {
    return "unknown";
  }
  return mapStatus(status);
}

/** Derive a flat standing per session from the store and watcher liveness. */
export function buildStandings(
  sessions: Record<string, UiSession>,
  parked: ReadonlySet<string>,
  lastSeen: Record<string, number>,
  lastChange: Record<string, number>,
  nowMs: number,
  hooksOff: Record<string, HooksOffScope> = {}
): SessionStanding[] {
  return Object.values(sessions)
    .filter((s) => !isPutAway(s, parked))
    .map((s) => ({
      sessionId: s.id,
      projectId: s.projectId,
      worktree: s.worktreePath,
      // With hooks off no status is ever reported, so a live watcher would
      // otherwise vouch for a guessed "idle".
      state:
        s.id in hooksOff
          ? "unknown"
          : standingState(s.status, lastSeen[s.id], nowMs),
      lastChangeMs: lastChange[s.id] ?? s.createdAt,
      lastSeenMs: lastSeen[s.id] ?? 0,
    }));
}

/** The standings that are blocked on the user (waiting on input right now). */
export function needsYou(standings: SessionStanding[]): SessionStanding[] {
  return standings.filter((s) => s.state === "awaiting_input");
}

/** A project with at least one standing. */
export interface ProjectStandings {
  project: ProjectRow;
  standings: SessionStanding[];
}

/**
 * Group standings under their project, preserving `projects` order and omitting
 * projects with no standings.
 */
export function groupByProject(
  standings: SessionStanding[],
  projects: ProjectRow[]
): ProjectStandings[] {
  const groups: ProjectStandings[] = [];
  for (const project of projects) {
    const owned = standings.filter((s) => s.projectId === project.id);
    if (owned.length > 0) {
      groups.push({ project, standings: owned });
    }
  }
  return groups;
}

/**
 * Watcher-liveness state, fed by backend signals: per-session last-seen time
 * (drives staleness) and last-status-change time (drives recency). Kept apart
 * from the session store so its high-frequency heartbeat churn never re-renders
 * the session views.
 */
interface CommandCenterState {
  lastChangeMs: Record<string, number>;
  lastSeenMs: Record<string, number>;
  /** A heartbeat carries the watcher's own last-pump time: keep the max. */
  recordHeartbeat: (id: string, lastSeenMs: number) => void;
  /** Any real event proves liveness "now": keep the max. */
  recordSeen: (id: string, nowMs: number) => void;
  /** A status change updates recency and proves liveness. */
  recordStatusChange: (id: string, nowMs: number) => void;
}

function maxSeen(
  lastSeenMs: Record<string, number>,
  id: string,
  value: number
): Record<string, number> {
  const existing = lastSeenMs[id];
  if (existing !== undefined && existing >= value) {
    return lastSeenMs;
  }
  return { ...lastSeenMs, [id]: value };
}

export const useCommandCenter = create<CommandCenterState>((set) => ({
  lastChangeMs: {},
  lastSeenMs: {},

  recordHeartbeat: (id, lastSeenMs) =>
    set((state) => ({ lastSeenMs: maxSeen(state.lastSeenMs, id, lastSeenMs) })),

  recordSeen: (id, nowMs) =>
    set((state) => ({ lastSeenMs: maxSeen(state.lastSeenMs, id, nowMs) })),

  recordStatusChange: (id, nowMs) =>
    set((state) => ({
      lastChangeMs: { ...state.lastChangeMs, [id]: nowMs },
      lastSeenMs: maxSeen(state.lastSeenMs, id, nowMs),
    })),
}));
