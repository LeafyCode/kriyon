import {
  onFocusSession,
  onPlanLimits,
  onSessionActivity,
  onSessionClaudeId,
  onSessionHandoff,
  onSessionHooksOff,
  onSessionReady,
  onSessionResources,
  onSessionSleeping,
  onSessionStatus,
  onSessionTitle,
  onSessionUsage,
  onWorkingTreeChanged,
} from "../ipc/bridge.ts";
import { onEvent, stopAll } from "../ipc/onEvent.ts";
import { focusSessionFromNotification, sessionBecameLive } from "./actions.ts";
import { applyWorkingTreeChange } from "./changesRefresh.ts";
import { useHandoffs } from "./handoffs.ts";
import { usePlanLimits } from "./planLimits.ts";
import { useSessions } from "./sessions.ts";

/**
 * Wire every backend session stream into the sessions store and return a
 * single cleanup that stops them all. One seam: a new stream is one more
 * entry. The race-safe subscribe→unlisten wiring lives in {@link onEvent};
 * the command center's recency/liveness projection of the same streams is
 * installed separately (see `commandCenterListeners.ts`).
 */
export function installSessionListeners(): () => void {
  const sessions = () => useSessions.getState();
  return stopAll([
    onEvent(onSessionStatus, (u) =>
      sessions().applyStatus(u.sessionId, u.status, u.summary, u.seeded)
    ),
    onEvent(onSessionUsage, (u) =>
      sessions().applyUsage(u.sessionId, u.snapshot)
    ),
    onEvent(onPlanLimits, (limits) => usePlanLimits.getState().apply(limits)),
    onEvent(onSessionResources, (u) => sessions().applyResources(u)),
    onEvent(onSessionSleeping, (u) =>
      sessions().applySleeping(u.sessionId, u.state)
    ),
    onEvent(onSessionActivity, (u) =>
      sessions().applyActivity(u.sessionId, u.snapshot)
    ),
    onEvent(onSessionHooksOff, (u) =>
      sessions().applyHooksOff(u.sessionId, u.scope)
    ),
    onEvent(onSessionTitle, (u) => sessions().applyTitle(u.sessionId, u.title)),
    // The [Working-tree watch]: real file changes under a watched repo,
    // whoever made them. Keyed by repo root rather than session id, so the
    // mapping back to a session lives in the store (several sessions can
    // share one checkout).
    onEvent(onWorkingTreeChanged, (u) => applyWorkingTreeChange(u.repoRoot)),
    onEvent(onSessionClaudeId, (u) =>
      sessions().applyClaudeId(u.sessionId, u.claudeSessionId)
    ),
    // A real SessionStart means the (resumed) session is live. The single
    // live transition disarms the watchdog, clears the boot overlay, and
    // clears any recovery prompt together (see sessionBecameLive).
    onEvent(onSessionReady, (u) => sessionBecameLive(u.sessionId)),
    // A turn wrote a [Handoff file]: offer it on a [Handoff card].
    onEvent(onSessionHandoff, (u) =>
      useHandoffs.getState().show(u.sessionId, u.path, u.prompt)
    ),
    onEvent(
      (cb: (u: { sessionId: string }) => void) =>
        // Adapt onFocusSession's bare-string callback to the `{ sessionId }`
        // update shape the other listeners share.
        onFocusSession((sessionId) => cb({ sessionId })),
      (u) => focusSessionFromNotification(u.sessionId)
    ),
  ]);
}
