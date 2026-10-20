import type { StoreApi, UseBoundStore } from "zustand";

function ignore(promise: Promise<unknown>): void {
  promise.catch(() => {
    // Fire-and-forget IPC; mirroring a store field to the backend is non-fatal.
  });
}

/**
 * Mirror one derived value of a zustand store to the backend: push the current
 * value once, then push again whenever it changes (reference-compared).
 * Collapses the near-identical subscribe-and-diff loops that keep the focused
 * session and the notify preference in sync with the Rust side — each "mirror a
 * store field to a bridge call" case is now this one call, not a hand-rolled
 * copy. Returns an unsubscribe function.
 */
export function mirrorToBridge<S, V>(
  store: UseBoundStore<StoreApi<S>>,
  select: (state: S) => V,
  push: (value: V) => Promise<unknown>
): () => void {
  let last = select(store.getState());
  ignore(push(last));
  return store.subscribe((state) => {
    const next = select(state);
    if (next !== last) {
      last = next;
      ignore(push(next));
    }
  });
}
