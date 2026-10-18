import { describe, expect, it } from "vitest";
import { clamp, lerp, lerpCam, MOTION, proj } from "./motion.ts";

describe("MOTION.glide", () => {
  it("holds `from` before the start mark", () => {
    expect(MOTION.glide(0.1, 0, 1, 0.4, 0.8)).toBe(0);
  });

  it("holds `to` after the end mark", () => {
    expect(MOTION.glide(0.95, 0, 1, 0.4, 0.8)).toBe(1);
  });

  it("is monotonic across the range", () => {
    let prev = Number.NEGATIVE_INFINITY;
    for (let p = 0; p <= 1; p += 0.01) {
      const v = MOTION.glide(p, 0, 1, 0.2, 0.9);
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
  });

  it("steps (never NaN) on a zero-length range", () => {
    expect(MOTION.glide(0.1, 0, 1, 0.5, 0.5)).toBe(0);
    expect(MOTION.glide(0.7, 0, 1, 0.5, 0.5)).toBe(1);
  });
});

describe("MOTION.enter", () => {
  it("starts at 0 and settles at 1", () => {
    expect(MOTION.enter(0, 0.2)).toBe(0);
    expect(MOTION.enter(0.2, 0.2)).toBe(0);
    expect(MOTION.enter(1, 0.2)).toBeCloseTo(1, 3);
  });
});

describe("MOTION.pop", () => {
  it("is 0 at both edges and peaks mid-range", () => {
    expect(MOTION.pop(0.4, 0.4, 0.6)).toBeCloseTo(0, 6);
    expect(MOTION.pop(0.6, 0.4, 0.6)).toBeCloseTo(0, 6);
    expect(MOTION.pop(0.5, 0.4, 0.6)).toBeCloseTo(1, 6);
  });

  it("clamps outside the range instead of going negative", () => {
    expect(MOTION.pop(0, 0.4, 0.6)).toBeCloseTo(0, 6);
    expect(MOTION.pop(1, 0.4, 0.6)).toBeCloseTo(0, 6);
  });
});

describe("camera math", () => {
  it("clamp and lerp behave at the edges", () => {
    expect(clamp(5, 0, 1)).toBe(1);
    expect(clamp(-5, 0, 1)).toBe(0);
    expect(lerp(10, 20, 0.5)).toBe(15);
  });

  it("lerpCam interpolates every axis", () => {
    const cam = lerpCam({ z: 1, cx: 0, cy: 0 }, { z: 2, cx: 1, cy: 0.5 }, 0.5);
    expect(cam).toEqual({ z: 1.5, cx: 0.5, cy: 0.25 });
  });

  it("proj maps the camera focus point to stage center", () => {
    const cam = { z: 1.5, cx: 0.4, cy: 0.36 };
    const shot = { src: "x", w: 1800, h: 1084 };
    expect(proj(cam, shot, cam.cx, cam.cy)).toEqual({ x: 960, y: 540 });
  });
});
