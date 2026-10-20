/**
 * The [Activity tab]'s data: one session's turns and the store's reach,
 * reloaded on `activity-changed` for that session and on a session switch.
 * An answer that arrives after the session changed is dropped, so a slow
 * read never paints one session's log under another.
 */
import { useEffect, useState } from "react";
import {
  type ActivityStats,
  type ActivityStepDetail,
  type ActivityTurn,
  activityStats,
  activityStep,
  activityTurns,
  onActivityChanged,
} from "../../ipc/bridge.ts";
import { failureMessage } from "../../ipc/failures.ts";
import { onEvent } from "../../ipc/onEvent.ts";

export interface ActivityLogView {
  /** Why the log couldn't be read, or `null`. */
  error: string | null;
  /** `null` until the first read lands. */
  stats: ActivityStats | null;
  turns: ActivityTurn[] | null;
}

const EMPTY: ActivityLogView = { error: null, stats: null, turns: null };

export function useActivityLog(sessionId: string): ActivityLogView {
  const [view, setView] = useState<ActivityLogView>(EMPTY);

  useEffect(() => {
    let current = true;
    setView(EMPTY);
    const load = () => {
      activityTurns(sessionId)
        .then((turns) => {
          if (current) {
            setView((v) => ({ ...v, error: null, turns }));
          }
        })
        .catch((err: unknown) => {
          if (current) {
            setView((v) => ({ ...v, error: failureMessage(err) }));
          }
        });
    };
    load();
    activityStats()
      .then((stats) => {
        if (current) {
          setView((v) => ({ ...v, stats }));
        }
      })
      .catch(() => {
        // The footer falls back to wording without numbers; the turns'
        // own read reports a broken store.
      });
    const stop = onEvent(onActivityChanged, (update) => {
      if (update.sessionId === sessionId) {
        load();
      }
    });
    return () => {
      current = false;
      stop();
    };
  }, [sessionId]);

  return view;
}

export type StepDetailView =
  | { state: "loading" }
  | { state: "gone" }
  | { message: string; state: "error" }
  | { detail: ActivityStepDetail; state: "ready" };

/** One step in full, for the [Step detail] dialog. */
export function useStepDetail(
  sessionId: string,
  stepId: number
): StepDetailView {
  const [view, setView] = useState<StepDetailView>({ state: "loading" });

  useEffect(() => {
    let current = true;
    setView({ state: "loading" });
    activityStep(sessionId, stepId)
      .then((detail) => {
        if (current) {
          setView(detail ? { detail, state: "ready" } : { state: "gone" });
        }
      })
      .catch((err: unknown) => {
        if (current) {
          setView({ message: failureMessage(err), state: "error" });
        }
      });
    return () => {
      current = false;
    };
  }, [sessionId, stepId]);

  return view;
}
