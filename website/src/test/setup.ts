import { cleanup } from "@testing-library/react";
import { afterEach, vi } from "vitest";

/* jsdom implements neither, and every animated component reads them. */
if (!window.matchMedia) {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {
      // no listeners in tests; components read `matches` on mount
    },
    removeEventListener: () => {
      // paired with addEventListener above
    },
    dispatchEvent: () => false,
    addListener: () => {
      // deprecated API, present for type compatibility
    },
    removeListener: () => {
      // deprecated API, present for type compatibility
    },
  })) as typeof window.matchMedia;
}

if (!globalThis.IntersectionObserver) {
  globalThis.IntersectionObserver = class {
    disconnect() {
      // never observes in tests; visibility is asserted at its initial value
    }
    observe() {
      // see disconnect
    }
    unobserve() {
      // see disconnect
    }
    takeRecords() {
      return [];
    }
    readonly root = null;
    readonly rootMargin = "";
    readonly thresholds = [];
  } as unknown as typeof IntersectionObserver;
}

/* Without `globals: true`, RTL does not register its own cleanup. */
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
