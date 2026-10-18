import { useEffect } from "react";
import { watchTranscript } from "../ipc/bridge.ts";
import type { StudioEvent } from "../types.ts";
import { useSessions } from "./sessions.ts";

/** How long appended events pool before one batched store update. */
const APPEND_FLUSH_MS = 16;

function ignore(promise: Promise<unknown>): void {
  promise.catch(() => {
    // The session watch is best-effort; failures are non-fatal.
  });
}

/**
 * Subscribes a mounted Session pane to its backend watch.
 *
 * The `watch_transcript` command is the session's whole watch, not just its
 * transcript: status, the reconstructed ask, activity (subagents, shells,
 * tasks), usage snapshots, the session title, the live Claude session id, and
 * the `session-ready` signal that dismisses the boot overlay all arrive through
 * it. Unsubscribing a mounted pane therefore blinds the sidebar, the Inspector
 * and notifications — not just the events fed back into the store here.
 *
 * The events themselves have no pane of their own any more; they feed the
 * usage totals, the unseen-output badges, the Needs-you snippet and the
 * handoff prompt.
 */
export function useSessionWatch(sessionId: string, enabled: boolean): void {
  useEffect(() => {
    if (!enabled) {
      return;
    }
    // The backend tailer replays from offset 0 on each (re)subscribe. Clearing
    // first resets the store slice; the store also dedupes by each event's
    // stable id, so replays (and `claude --resume`, which re-tails the whole
    // transcript) never stack duplicates. The cancelled guard drops a stale
    // subscription's late events after this effect re-runs.
    let cancelled = false;
    // Pool the arrival burst (replay, command output) into one store update
    // per flush window so a K-event result costs one update, not K.
    let pooled: StudioEvent[] = [];
    let flushTimer: ReturnType<typeof setTimeout> | null = null;
    const flush = () => {
      flushTimer = null;
      if (!cancelled && pooled.length > 0) {
        const batch = pooled;
        pooled = [];
        useSessions.getState().appendEvents(sessionId, batch);
      }
    };
    useSessions.getState().clearEvents(sessionId);
    ignore(
      watchTranscript(sessionId, (e) => {
        if (cancelled) {
          return;
        }
        pooled.push(e);
        flushTimer ??= setTimeout(flush, APPEND_FLUSH_MS);
      })
    );
    return () => {
      cancelled = true;
      if (flushTimer !== null) {
        clearTimeout(flushTimer);
      }
    };
  }, [sessionId, enabled]);
}
