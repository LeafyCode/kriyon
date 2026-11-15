/**
 * The app lock's rules. A phone that a computer gave the Controller role can
 * type into that computer's terminal, so a lost phone must not open on its
 * sessions: the app asks for Face ID, Touch ID, the fingerprint or the
 * phone's passcode on opening, and again after it was away long enough. On
 * by default for a Controller; the person may turn it on for a Viewer, or
 * off. Rust keeps the setting (`appLock`); this decides.
 */

/** The seconds away that lock the app again: at once, 1, 5, 15 minutes. */
export const LOCK_AFTER = [0, 60, 300, 900] as const;

/** The app lock as the person set it: `on` null until they choose. */
export interface AppLock {
  afterS: number;
  on: boolean | null;
}

const NOT_CHOSEN: AppLock = { afterS: 300, on: null };

/** The kept setting, from Rust's JSON; anything odd is "not chosen". */
export function readAppLock(json: string): AppLock {
  let read: unknown;
  try {
    read = JSON.parse(json);
  } catch {
    return NOT_CHOSEN;
  }
  const { afterS, on } = (read ?? {}) as Record<string, unknown>;
  const timeOk = LOCK_AFTER.some((one) => one === afterS);
  const onOk = on === null || typeof on === "boolean";
  if (!(timeOk && onOk)) {
    return NOT_CHOSEN;
  }
  return { afterS: afterS as number, on: on as boolean | null };
}

/**
 * Whether the lock is on: as the person set it, or, not chosen, whenever a
 * paired computer gave this phone the Controller role.
 */
export function lockIsOn(lock: AppLock, controllerSomewhere: boolean): boolean {
  return lock.on ?? controllerSomewhere;
}

/** A lock time in words: "Immediately", "After 5 minutes". */
export function lockAfterWords(afterS: number): string {
  if (afterS === 0) {
    return "Immediately";
  }
  const minutes = Math.round(afterS / 60);
  return minutes === 1 ? "After 1 minute" : `After ${minutes} minutes`;
}

/** Locked or open, and since when the app was away (if it is). */
export interface LockState {
  awayAtMs: number | null;
  locked: boolean;
}

/** What happens to the app: it starts, goes away, comes back, is unlocked. */
export type LockEvent =
  | { kind: "start" }
  | { atMs: number; kind: "away" }
  | { atMs: number; kind: "back" }
  | { kind: "unlocked" };

/** The lock after `event`, with the lock `on` and `afterS` away locking it. */
export function nextLock(
  state: LockState,
  event: LockEvent,
  rule: { afterS: number; on: boolean }
): LockState {
  if (!rule.on) {
    return { awayAtMs: null, locked: false };
  }
  switch (event.kind) {
    case "start":
      return { awayAtMs: null, locked: true };
    case "away":
      // Away again before coming back: still counted from the first.
      return { ...state, awayAtMs: state.awayAtMs ?? event.atMs };
    case "back": {
      const away = state.awayAtMs === null ? 0 : event.atMs - state.awayAtMs;
      const timeUp = state.awayAtMs !== null && away >= rule.afterS * 1000;
      return { awayAtMs: null, locked: state.locked || timeUp };
    }
    case "unlocked":
      return { awayAtMs: null, locked: false };
    default:
      return state;
  }
}
