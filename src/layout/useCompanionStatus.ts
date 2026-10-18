import { useEffect, useState } from "react";
import {
  type CompanionState,
  type CompanionStatus,
  companionStatus,
  onCompanionChanged,
} from "../ipc/bridge.ts";
import { onEvent } from "../ipc/onEvent.ts";
import { useIntegration } from "../state/integration.ts";

/** How often a not-yet-settled companion is asked again. */
const RECHECK_MS = 5000;

/** States that only change with a post (an event) or a restart — no polling. */
const SETTLED: ReadonlySet<CompanionState> = new Set(["on", "off", "blocked"]);

/**
 * One session's companion as the backend sees it, kept fresh: on each post
 * the companion makes, every few seconds while it hasn't settled, and when the
 * user changes what Kriyon adds (turning the companion on makes a running
 * session `needsRestart`, with no post to say so).
 */
export function useCompanionStatus(sessionId: string): CompanionStatus | null {
  const [status, setStatus] = useState<CompanionStatus | null>(null);
  const prefs = useIntegration((state) => state.status?.prefs);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `prefs` is here only to re-ask the backend after a Settings change.
  useEffect(() => {
    if (!sessionId) {
      // No session (the empty header): nothing to ask about.
      setStatus(null);
      return;
    }
    let alive = true;
    let timer: number | undefined;
    const stopPolling = () => {
      window.clearInterval(timer);
      timer = undefined;
    };
    const refresh = () => {
      companionStatus(sessionId)
        .then((next) => {
          if (!alive) {
            return;
          }
          setStatus(next);
          if (SETTLED.has(next.state)) {
            stopPolling();
          } else {
            timer ??= window.setInterval(refresh, RECHECK_MS);
          }
        })
        .catch(() => {
          // An unknown state shows no chip; the next refresh tries again.
        });
    };
    refresh();
    // Poll until the first answer settles it; a failed first ask keeps polling.
    timer = window.setInterval(refresh, RECHECK_MS);
    const stop = onEvent(onCompanionChanged, (update) => {
      if (update.sessionId === sessionId) {
        refresh();
      }
    });
    return () => {
      alive = false;
      stop();
      stopPolling();
    };
  }, [sessionId, prefs]);
  return status;
}
