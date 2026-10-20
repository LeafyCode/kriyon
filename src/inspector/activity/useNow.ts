import { useEffect, useState } from "react";

/**
 * A single 1-second ticker shared by every live-elapsed consumer in the
 * Inspector, so a busy session ticks all running rows off one interval rather
 * than one timer per row. Subscribers re-render together; the interval runs only
 * while at least one consumer is mounted.
 */
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | undefined;

function ensureTimer(): void {
  if (timer === undefined) {
    timer = setInterval(() => {
      for (const notify of listeners) {
        notify();
      }
    }, 1000);
  }
}

/** Current epoch milliseconds, refreshed once per second. */
export function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const notify = () => setNow(Date.now());
    listeners.add(notify);
    ensureTimer();
    return () => {
      listeners.delete(notify);
      if (listeners.size === 0 && timer !== undefined) {
        clearInterval(timer);
        timer = undefined;
      }
    };
  }, []);
  return now;
}
