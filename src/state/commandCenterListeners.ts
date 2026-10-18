import {
  onSessionActivity,
  onSessionHeartbeat,
  onSessionStatus,
  onSessionUsage,
  type StatusUpdate,
} from "../ipc/bridge.ts";
import { onEvent, stopAll } from "../ipc/onEvent.ts";
import { useCommandCenter } from "./commandCenter.ts";

/**
 * When a status update means the session was last active — or `null` when it
 * carries no recency signal at all and must not be recorded.
 *
 * A live update happened now. A *seeded* one did not: the backend rebuilt it by
 * replaying the events file at launch, so stamping it "now" told the recency
 * projection that every session had just been active. That is what silently
 * disabled the age-based "N older" fold — after every launch, no session was
 * ever old enough to fold. A seeded update reports when its newest replayed
 * event actually happened; if the replay carries no timestamp we record
 * nothing, and the fold falls back to the session's `createdAt`.
 */
export function statusChangeAt(update: StatusUpdate): number | null {
  if (!update.seeded) {
    return Date.now();
  }
  if (!update.lastEventAt) {
    return null;
  }
  const parsed = Date.parse(update.lastEventAt);
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * Wire the [Command center]'s recency/liveness projection of the backend
 * session streams: status changes bump both recency and liveness, any real
 * event proves the watcher's pump is alive, and the heartbeat carries the
 * watcher's own last-pump time for [Standing staleness]. Installed alongside
 * `installSessionListeners` (which feeds the sessions store from the same
 * streams); the two projections are independent, so neither orders the other.
 */
export function installCommandCenterListeners(): () => void {
  const center = () => useCommandCenter.getState();
  return stopAll([
    onEvent(onSessionStatus, (u) => {
      const at = statusChangeAt(u);
      if (at !== null) {
        center().recordStatusChange(u.sessionId, at);
      }
    }),
    onEvent(onSessionUsage, (u) =>
      center().recordSeen(u.sessionId, Date.now())
    ),
    onEvent(onSessionActivity, (u) =>
      center().recordSeen(u.sessionId, Date.now())
    ),
    onEvent(onSessionHeartbeat, (u) =>
      center().recordHeartbeat(u.sessionId, u.lastSeenMs)
    ),
  ]);
}
