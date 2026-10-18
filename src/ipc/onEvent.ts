/**
 * Subscribe to a backend event stream, race-safely.
 *
 * Tauri's `listen` resolves to its unlisten function some time after the call,
 * so naive wiring leaks the subscription when teardown runs first (a fast
 * unmount, a strict-mode double effect). This helper owns that one fact for
 * every subscriber in the app — main window and tray alike: if the returned
 * cleanup ran before the subscription resolved, the unlisten fires on resolve.
 *
 * A failed subscription is swallowed: backend events are enhancement, and a
 * missing stream must never take the UI down.
 */
export function onEvent<T>(
  subscribe: (cb: (update: T) => void) => Promise<() => void>,
  cb: (update: T) => void
): () => void;
export function onEvent(
  subscribe: (cb: () => void) => Promise<() => void>,
  cb: () => void
): () => void;
export function onEvent(
  subscribe: (cb: (...args: unknown[]) => void) => Promise<() => void>,
  cb: (...args: unknown[]) => void
): () => void {
  let unlisten: (() => void) | undefined;
  let stopped = false;

  subscribe(cb)
    .then((fn) => {
      if (stopped) {
        fn();
      } else {
        unlisten = fn;
      }
    })
    .catch(() => {
      // Fire-and-forget: a failed event subscription is non-fatal.
    });

  return () => {
    stopped = true;
    unlisten?.();
  };
}

/** Compose several cleanups into one (subscription teardown convenience). */
export function stopAll(stops: ReadonlyArray<() => void>): () => void {
  return () => {
    for (const stop of stops) {
      stop();
    }
  };
}
