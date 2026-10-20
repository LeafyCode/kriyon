import { vi } from "vitest";

/**
 * Swaps the never-firing IntersectionObserver from `setup.ts` for one a test
 * can drive, so scroll-triggered behaviour can be checked. `scrollIntoView`
 * reports every observed element as on screen; `scrollAway` as off it.
 */
export function controlledIntersection() {
  const observers = new Set<{
    callback: IntersectionObserverCallback;
    targets: Set<Element>;
  }>();

  class Controlled {
    readonly root = null;
    readonly rootMargin = "";
    readonly thresholds = [];
    private readonly entry: {
      callback: IntersectionObserverCallback;
      targets: Set<Element>;
    };

    constructor(callback: IntersectionObserverCallback) {
      this.entry = { callback, targets: new Set() };
      observers.add(this.entry);
    }
    observe(el: Element) {
      this.entry.targets.add(el);
    }
    unobserve(el: Element) {
      this.entry.targets.delete(el);
    }
    disconnect() {
      observers.delete(this.entry);
    }
    takeRecords() {
      return [];
    }
  }

  vi.stubGlobal("IntersectionObserver", Controlled);

  const fire = (isIntersecting: boolean) => {
    for (const { callback, targets } of [...observers]) {
      const entries = [...targets].map(
        (target) => ({ isIntersecting, target }) as IntersectionObserverEntry
      );
      callback(entries, {} as IntersectionObserver);
    }
  };

  return {
    scrollIntoView: () => fire(true),
    scrollAway: () => fire(false),
  };
}
