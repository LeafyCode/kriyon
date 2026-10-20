import { describe, expect, it } from "vitest";
import {
  MAX_WARM_PANES,
  nextWarmPanes,
  sessionPaneMounts,
} from "./warmPanes.ts";

describe("nextWarmPanes", () => {
  it("promotes the departing session to the front of the warm list", () => {
    const { warm, evicted } = nextWarmPanes([], "a", "b");
    expect(warm).toEqual(["a"]);
    expect(evicted).toEqual([]);
  });

  it("never keeps the arriving (now active) session in the warm list", () => {
    // Returning to a warm session makes it active, so it leaves the warm set.
    const { warm } = nextWarmPanes(["a", "b"], "c", "a");
    expect(warm).not.toContain("a");
    expect(warm).toEqual(["c", "b"]);
  });

  it("re-departing an already-warm session moves it to the front without duplicating", () => {
    const { warm } = nextWarmPanes(["b", "a"], "a", "z");
    expect(warm).toEqual(["a", "b"]);
  });

  it("does nothing extra on the first activation (no prior active session)", () => {
    const { warm, evicted } = nextWarmPanes([], null, "a");
    expect(warm).toEqual([]);
    expect(evicted).toEqual([]);
  });

  it("evicts the least-recently-used session once the cap is exceeded", () => {
    // Fill the warm set to the cap, most-recent first (so `s${cap - 1}` is the
    // least-recently-left).
    const full = Array.from({ length: MAX_WARM_PANES }, (_, i) => `s${i}`);
    const oldest = `s${MAX_WARM_PANES - 1}`;
    const { warm, evicted } = nextWarmPanes(full, "new", "active");
    expect(warm).toHaveLength(MAX_WARM_PANES);
    expect(warm[0]).toBe("new");
    expect(evicted).toEqual([oldest]);
    expect(warm).not.toContain(oldest);
  });

  it("respects an explicit cap", () => {
    const { warm, evicted } = nextWarmPanes(["b", "c"], "a", "z", 2);
    expect(warm).toEqual(["a", "b"]);
    expect(evicted).toEqual(["c"]);
  });
});

describe("sessionPaneMounts", () => {
  it("mounts the active session and any warm session, nothing else", () => {
    expect(sessionPaneMounts("a", [], "a")).toBe(true); // active
    expect(sessionPaneMounts("a", ["b"], "b")).toBe(true); // warm
    expect(sessionPaneMounts("a", [], "b")).toBe(false); // never viewed
    expect(sessionPaneMounts(null, [], "a")).toBe(false); // nothing active
  });
});
