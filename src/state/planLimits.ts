import { useEffect, useMemo, useState } from "react";
import { create } from "zustand";
import type { LimitWindow, PlanLimits } from "../types.ts";
import {
  type LimitSample,
  type LimitSamples,
  type PlanLimitsView,
  planLimitsView,
} from "./usage.ts";

/**
 * The account's [Plan limits] (5-hour and weekly use). Account-wide, not per
 * session, so it lives apart from the sessions store. Fed by the backend's
 * `plan-limits` event.
 */
interface PlanLimitsState {
  apply: (limits: PlanLimits, nowMs?: number) => void;
  limits: PlanLimits;
  /** Each window's readings since it last reset, for its [Limit pace]. */
  samples: LimitSamples;
}

/** Readings kept per window; the pace reads only the last hour. */
const MAX_SAMPLES = 240;

/** `old` with `next` appended, or started over when the window reset. */
function withSample(
  old: LimitSample[],
  before: LimitWindow | null,
  next: LimitWindow | null,
  nowMs: number
): LimitSample[] {
  if (next === null) {
    return [];
  }
  const kept = before !== null && before.resetsAt === next.resetsAt ? old : [];
  return [...kept, { atMs: nowMs, usedPercentage: next.usedPercentage }].slice(
    -MAX_SAMPLES
  );
}

function sameWindow(a: LimitWindow | null, b: LimitWindow | null): boolean {
  return (
    a === b ||
    (a !== null &&
      b !== null &&
      a.resetsAt === b.resetsAt &&
      a.usedPercentage === b.usedPercentage)
  );
}

export const usePlanLimits = create<PlanLimitsState>((set, get) => ({
  // The backend re-sends an unchanged answer every few seconds; keeping the
  // old object then spares every reader a re-render.
  apply: (limits, nowMs = Date.now()) => {
    const { limits: old, samples } = get();
    if (
      sameWindow(old.fiveHour, limits.fiveHour) &&
      sameWindow(old.sevenDay, limits.sevenDay)
    ) {
      return;
    }
    set({
      limits,
      samples: {
        fiveHour: withSample(
          samples.fiveHour,
          old.fiveHour,
          limits.fiveHour,
          nowMs
        ),
        sevenDay: withSample(
          samples.sevenDay,
          old.sevenDay,
          limits.sevenDay,
          nowMs
        ),
      },
    });
  },
  limits: { fiveHour: null, sevenDay: null },
  samples: { fiveHour: [], sevenDay: [] },
}));

/** How often reset times are re-read, so "2:40 PM" becomes "Mon 2:40 PM"
 *  (or the reverse) when the day turns without a new reading. */
const CLOCK_MS = 60_000;

/** The [Plan limits view] of the current limits, kept current by the minute. */
export function usePlanLimitsView(): PlanLimitsView {
  const limits = usePlanLimits((state) => state.limits);
  const samples = usePlanLimits((state) => state.samples);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), CLOCK_MS);
    return () => window.clearInterval(timer);
  }, []);
  return useMemo(
    () => planLimitsView(limits, now, samples),
    [limits, now, samples]
  );
}
