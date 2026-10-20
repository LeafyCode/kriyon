/* Timing math for the product film — ported from the design's
   animations-v2 engine (Easing/animate/clamp) and kriyon-video MOTION. */

export function clamp(v: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, v));
}

export function lerp(a: number, b: number, t: number) {
  return a + (b - a) * t;
}

function easeInOutCubic(t: number) {
  return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
}

function easeOutExpo(t: number) {
  return t === 1 ? 1 : 1 - 2 ** (-10 * t);
}

function animate(
  from: number,
  to: number,
  start: number,
  end: number,
  ease: (t: number) => number
) {
  if (end === start) {
    // zero-length range: a step, not a NaN
    return (p: number) => (p < start ? from : to);
  }
  return (p: number) =>
    lerp(from, to, ease(clamp((p - start) / (end - start), 0, 1)));
}

/* The three motion helpers — nothing in the film eases outside these. */
export const MOTION = {
  /** damped A→B between two progress marks */
  glide: (p: number, from: number, to: number, s: number, e: number) =>
    animate(from, to, s, e, easeInOutCubic)(p),
  /** entrance that settles quickly and stays */
  enter: (p: number, s: number, d = 0.14) =>
    animate(0, 1, s, s + d, easeOutExpo)(p),
  /** 0 → 1 → 0 emphasis, safe at scene edges */
  pop: (p: number, s: number, e: number) =>
    Math.sin(Math.PI * clamp((p - s) / (e - s), 0, 1)),
};

export interface Camera {
  cx: number;
  cy: number;
  z: number;
}
export interface Shot {
  h: number;
  src: string;
  w: number;
}

export const STAGE_W = 1920;
export const STAGE_H = 1080;

export function lerpCam(a: Camera, b: Camera, t: number): Camera {
  return {
    z: lerp(a.z, b.z, t),
    cx: lerp(a.cx, b.cx, t),
    cy: lerp(a.cy, b.cy, t),
  };
}

/** normalized screenshot point → stage px, for the current camera */
export function proj(cam: Camera, shot: Shot, px: number, py: number) {
  return {
    x: STAGE_W / 2 + (px - cam.cx) * shot.w * cam.z,
    y: STAGE_H / 2 + (py - cam.cy) * shot.h * cam.z,
  };
}
