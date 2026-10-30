import { create } from "zustand";

/**
 * [Boot time]: how long each session took from the moment Kriyon launched or
 * resumed `claude` to the moment it was live (its `SessionStart` hook fired).
 * Kept per session for this run only — it is a reading for the Inspector, not
 * a record — so a slow start is visible instead of guessed at.
 */
interface BootTimesState {
  /** The last measured boot of each session, in ms. */
  ms: Record<string, number>;
  /** When each boot underway began (epoch ms). */
  started: Record<string, number>;
}

export const useBootTimes = create<BootTimesState>(() => ({
  ms: {},
  started: {},
}));

/** A launch is underway: start the clock (a relaunch restarts it). */
export function markBootStart(sessionId: string, nowMs: number): void {
  useBootTimes.setState((state) => ({
    started: { ...state.started, [sessionId]: nowMs },
  }));
}

/** The session is live: record the time since its launch, if one was timed. */
export function markBootLive(sessionId: string, nowMs: number): void {
  const began = useBootTimes.getState().started[sessionId];
  if (began === undefined) {
    return;
  }
  useBootTimes.setState((state) => {
    const { [sessionId]: _done, ...started } = state.started;
    return {
      ms: { ...state.ms, [sessionId]: Math.max(0, nowMs - began) },
      started,
    };
  });
}

/** "1.3s", "420ms", or "—" before a boot has been timed. */
export function formatBootTime(ms: number | undefined): string {
  if (ms === undefined) {
    return "—";
  }
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}
