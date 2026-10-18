import "@testing-library/jest-dom/vitest";

// jsdom does not implement ResizeObserver. Provide a no-op stub so components
// that observe element size can mount under test.
if (!("ResizeObserver" in globalThis)) {
  class ResizeObserverStub {
    observe(): void {
      // no-op
    }
    unobserve(): void {
      // no-op
    }
    disconnect(): void {
      // no-op
    }
  }
  globalThis.ResizeObserver = ResizeObserverStub;
}

// jsdom also does not implement IntersectionObserver (used by DiffFeed's
// viewed/active tracking, Task 10). A no-op default keeps every other test
// file that merely mounts DiffFeed from crashing; DiffFeed.test.tsx installs
// its own controllable fake via `vi.stubGlobal` (restored after each test)
// whenever it needs to actually drive intersection callbacks.
if (!("IntersectionObserver" in globalThis)) {
  class IntersectionObserverStub {
    observe(): void {
      // no-op
    }
    unobserve(): void {
      // no-op
    }
    disconnect(): void {
      // no-op
    }
  }
  globalThis.IntersectionObserver =
    IntersectionObserverStub as unknown as typeof IntersectionObserver;
}
