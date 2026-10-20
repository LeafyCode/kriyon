import type { SessionActivity } from "../types.ts";

/**
 * What the user had seen when they last left a Session (see CONTEXT.md "Viewed
 * marker"). Stamped at activation and queried by the Needs-you section and the
 * sidebar's age fold for unseen counts.
 *
 * It stores the monotonic append counter — NOT an event-array length — so the
 * unseen window survives the event ring's front-eviction at MAX_EVENTS, where a
 * stored offset silently goes wrong (`events.slice(offset)` yields `[]` once the
 * array length pins at the cap).
 */
export interface ViewedMarker {
  /** The live append counter's value when the session was last viewed. */
  appendSeq: number;
  /** Wall-clock ms when the session was last the active one. */
  ms: number;
  /** Completed-task count when the session was last viewed. */
  tasksDone: number;
}

/** Completed entries in the session's current task list — the marker's stamp value. */
export function completedTasks(activity: SessionActivity | undefined): number {
  return activity?.tasks.filter((t) => t.status === "completed").length ?? 0;
}

/** Build a Viewed marker for the moment a session becomes active. */
export function stampViewed(args: {
  appendSeq: number;
  nowMs: number;
  tasksDone: number;
}): ViewedMarker {
  return {
    appendSeq: args.appendSeq,
    ms: args.nowMs,
    tasksDone: args.tasksDone,
  };
}

/**
 * Events appended since the marker, from the live append counter — monotonic,
 * so it stays correct after the ring evicts. A never-viewed session (no marker)
 * counts everything as unseen. Clamped at zero.
 */
export function unseenCount(
  marker: ViewedMarker | undefined,
  appendSeq: number
): number {
  return Math.max(0, appendSeq - (marker?.appendSeq ?? 0));
}

/**
 * Events the user genuinely hasn't seen: {@link unseenCount}, except that a
 * session whose status came from a launch replay has none by definition.
 *
 * The single home for that question. `appendSeq` climbs on every replayed
 * event while `viewed` lives only in memory, so a raw `unseenCount` calls a
 * whole re-tailed transcript "unseen" after every launch. Two surfaces ask
 * this — the Needs-you section and the sidebar's age fold — and when each
 * asked it its own way they disagreed: Needs-you filled with old finished
 * sessions, while the age fold refused to fold those same rows because it
 * believed they had unread output.
 */
export function unseenOutput(args: {
  appendSeq: number;
  marker: ViewedMarker | undefined;
  origin: "seeded" | "live" | undefined;
}): number {
  if (args.origin === "seeded") {
    return 0;
  }
  return unseenCount(args.marker, args.appendSeq);
}
