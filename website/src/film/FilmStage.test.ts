import { describe, expect, it } from "vitest";
import { FILM_SECONDS, sceneAt } from "./FilmStage.tsx";

describe("the film's cut list", () => {
  it("runs 66 seconds, matching the section label", () => {
    expect(FILM_SECONDS).toBe(66);
  });
});

describe("sceneAt", () => {
  it("starts in the opening scene at progress 0", () => {
    const { progress } = sceneAt(0);
    expect(progress).toBe(0);
  });

  it("keeps progress within [0, 1) inside a scene", () => {
    for (let t = 0; t < FILM_SECONDS; t += 0.5) {
      const { progress } = sceneAt(t);
      expect(progress).toBeGreaterThanOrEqual(0);
      expect(progress).toBeLessThan(1);
    }
  });

  it("switches scenes exactly at cumulative boundaries", () => {
    // Opening runs 0–7s; Sessions starts at 7s
    const before = sceneAt(6.999);
    const after = sceneAt(7);
    expect(before.scene).not.toBe(after.scene);
    expect(after.progress).toBe(0);
  });

  it("holds the end card at the exact end of the timeline", () => {
    const { progress } = sceneAt(FILM_SECONDS);
    expect(progress).toBe(1);
  });

  it("places the reduced-motion poster frame mid end-card", () => {
    const poster = sceneAt(FILM_SECONDS - 3);
    expect(poster.progress).toBeCloseTo(0.5, 6);
    expect(poster.scene).toBe(sceneAt(FILM_SECONDS).scene);
  });
});
