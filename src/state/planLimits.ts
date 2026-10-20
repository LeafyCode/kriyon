import { useEffect, useMemo, useState } from "react";
import { create } from "zustand";
import type { LimitWindow, PlanLimits } from "../types.ts";
import { type PlanLimitsView, planLimitsView } from "./usage.ts";

/**
 * The account's [Plan limits] (5-hour and weekly use). Account-wide, not per
 * session, so it lives apart from the sessions store. Fed by the backend's
 * `plan-limits` event.
 */
interface PlanLimitsState {
  apply: (limits: PlanLimits) => void;
  limits: PlanLimits;
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
  apply: (limits) => {
    const { limits: old } = get();
    if (
      sameWindow(old.fiveHour, limits.fiveHour) &&
      sameWindow(old.sevenDay, limits.sevenDay)
    ) {
      return;
    }
    set({ limits });
  },
  limits: { fiveHour: null, sevenDay: null },
}));

/** How often reset times are re-read, so "2:40 PM" becomes "Mon 2:40 PM"
 *  (or the reverse) when the day turns without a new reading. */
const CLOCK_MS = 60_000;

/** The [Plan limits view] of the current limits, kept current by the minute. */
export function usePlanLimitsView(): PlanLimitsView {
  const limits = usePlanLimits((state) => state.limits);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), CLOCK_MS);
    return () => window.clearInterval(timer);
  }, []);
  return useMemo(() => planLimitsView(limits, now), [limits, now]);
}
