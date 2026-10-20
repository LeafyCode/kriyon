/**
 * The outcome of one [SWR resource] revalidation, handed to the adapter's
 * settle handler only while this request is still the newest for its key.
 */
export interface SwrOutcome<T> {
  /** True only for a cold failure: the fetch threw and no cached value exists. */
  coldFailure: boolean;
  /**
   * The value to render now: the fresh fetch on success, or the last cached
   * value when a refetch fails and one exists (stale-on-error). `undefined`
   * only for a cold failure — a fetch that threw with nothing cached.
   */
  value: T | undefined;
}

/**
 * Lifecycle callbacks for one revalidation. Only the newest request per key
 * fires `onSettle`/`onDone`, so a superseded slow response cannot flip an
 * adapter's state back.
 */
export interface SwrHandlers<T> {
  /** The newest in-flight fetch for the key ended — adapters flip loading off. */
  onDone?: () => void;
  /** The fetch settled and this request is still current: render `outcome`. */
  onSettle?: (outcome: SwrOutcome<T>) => void;
  /** A fetch has begun — adapters flip loading on and clear any prior failure. */
  onStart?: () => void;
}

/**
 * A keyed stale-while-revalidate resource: a per-key value cache plus a per-key
 * monotonic seq-guard, so a slow early response can never overwrite a fresher
 * one, and a failed refetch serves the last cached value instead of nulling.
 * Both History-page discovery and repo-status fetching sit behind one of these.
 */
export interface SwrResource<T> {
  /** Drop every cached value and reset the seq-guards (cache-clear / test seam). */
  clear: () => void;
  /** Synchronous read of the last-known value for a key, or `undefined`. */
  peek: (key: string) => T | undefined;
  /**
   * Revalidate a key with `fetcher`, seq-guarded and stale-on-error. Handlers
   * fire only while this is the newest request for the key; a superseded slow
   * response is dropped without touching the cache or the handlers.
   */
  revalidate: (
    key: string,
    fetcher: () => Promise<T>,
    handlers?: SwrHandlers<T>
  ) => Promise<void>;
  /**
   * Subscribe to a key's cache writes: `listener` fires with the fresh value
   * whenever a revalidation for `key` succeeds. This lets one module-level
   * resource back many concurrent consumers of the same key — the seq-guard
   * decides which request wins the cache write, but delivery goes to EVERY
   * subscriber, so no consumer is left blank by losing the race. Returns an
   * unsubscribe function. A failed refetch notifies no one (its stale value is
   * served to the revalidating caller via {@link SwrHandlers.onSettle}).
   */
  subscribe: (key: string, listener: (value: T) => void) => () => void;
}

/** Build a fresh, independent [SWR resource] over values of type `T`. */
export function createSwrResource<T>(): SwrResource<T> {
  /** Per-key cache, alive for the resource's lifetime — the "stale" served. */
  const cache = new Map<string, T>();
  /**
   * Latest request number per key. A response only lands if it is still the
   * newest request for its key; otherwise a slow early fetch resolving last
   * would overwrite a fresher value and poison the cache.
   */
  const seqs = new Map<string, number>();
  /** Cache-write listeners per key — see {@link SwrResource.subscribe}. */
  const listeners = new Map<string, Set<(value: T) => void>>();

  function notify(key: string, value: T): void {
    const set = listeners.get(key);
    if (!set) {
      return;
    }
    for (const listener of set) {
      listener(value);
    }
  }

  return {
    peek(key) {
      return cache.get(key);
    },

    subscribe(key, listener) {
      let set = listeners.get(key);
      if (!set) {
        set = new Set();
        listeners.set(key, set);
      }
      set.add(listener);
      return () => {
        set.delete(listener);
        if (set.size === 0) {
          listeners.delete(key);
        }
      };
    },

    async revalidate(key, fetcher, handlers) {
      const seq = (seqs.get(key) ?? 0) + 1;
      seqs.set(key, seq);
      handlers?.onStart?.();
      try {
        const value = await fetcher();
        if (seqs.get(key) !== seq) {
          return; // A newer request superseded this one; drop the stale value.
        }
        cache.set(key, value);
        notify(key, value);
        handlers?.onSettle?.({ coldFailure: false, value });
      } catch {
        if (seqs.get(key) !== seq) {
          return;
        }
        // Best-effort: keep serving the last cached value rather than break the
        // view; a cold failure (nothing cached) is admitted, never faked empty.
        const cached = cache.get(key);
        handlers?.onSettle?.({
          coldFailure: cached === undefined,
          value: cached,
        });
      } finally {
        if (seqs.get(key) === seq) {
          handlers?.onDone?.();
        }
      }
    },

    clear() {
      cache.clear();
      seqs.clear();
    },
  };
}
