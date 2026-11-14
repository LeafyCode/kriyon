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
 * carries no recency signal and must not be recorded.
 *
 * A live update happened now. A *seeded* one is history: the backend rebuilt
 * it by replaying the events file when the session's watch started. Stamping
 * it "now" told the recency projection that every session had just been
 * active, so the age fold never fired after a restart; stamping it with its
 * own replayed time let merely opening a session make it look older than it
 * was. Past activity has one source instead — the Activity log, seeded for
 * every session at hydrate (`seedLastChange`) — so a replay records nothing.
 */
export function statusChangeAt(update: StatusUpdate): number | null {
  return update.seeded ? null : Date.now();
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
