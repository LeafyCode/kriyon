import type { MascotId } from "../state/layout.ts";

/**
 * What a [Mascot] does besides float: one-off tricks, played at random every
 * few seconds (sooner while Claude works) and on a click, never the same
 * twice in a row; and the face it wears. Each trick is a CSS animation keyed
 * by `data-move` (mascot.css); this module only decides which plays next,
 * when, and with what face.
 */

export type MoveId =
  | "blink"
  | "hop"
  | "spin"
  | "look-around"
  | "wink"
  | "surprise"
  | "nod"
  | "shiver"
  | "doze"
  | "peek"
  | "giggle"
  | "glow"
  | "tilt"
  | "aha"
  | "ponder"
  | "sparkle"
  | "orbit"
  | "scan"
  | "glitch"
  | "facet-flash"
  | "twirl";

/** How long each move runs, matching its CSS animation. */
export const MOVE_MS: Record<MoveId, number> = {
  "facet-flash": 1400,
  "look-around": 1800,
  aha: 1300,
  blink: 600,
  doze: 3200,
  giggle: 1300,
  glitch: 700,
  glow: 1600,
  hop: 900,
  nod: 900,
  orbit: 1800,
  peek: 1400,
  ponder: 2200,
  scan: 1400,
  shiver: 700,
  sparkle: 1100,
  spin: 1100,
  surprise: 1000,
  tilt: 1500,
  twirl: 1200,
  wink: 900,
};

type Kind = Exclude<MascotId, "none">;

/** What every one does when idle. */
const IDLE: readonly MoveId[] = [
  "blink",
  "blink",
  "hop",
  "spin",
  "look-around",
  "wink",
  "surprise",
  "nod",
  "shiver",
  "doze",
  "peek",
  "giggle",
  "glow",
  "tilt",
];

/** Thinking ones only, while Claude works: no dozing off, no capers. */
const BUSY: readonly MoveId[] = [
  "aha",
  "ponder",
  "look-around",
  "nod",
  "blink",
];

/** Each one's own, idle and while it thinks. */
const OWN: Record<Kind, readonly MoveId[]> = {
  gem: ["sparkle", "orbit"],
  hex: ["facet-flash", "twirl"],
  visor: ["scan", "glitch"],
};
const OWN_BUSY: Record<Kind, readonly MoveId[]> = {
  gem: ["orbit"],
  hex: ["facet-flash"],
  visor: ["scan"],
};

/** The moves `kind` can play now. */
export function movesFor(kind: Kind, busy: boolean): readonly MoveId[] {
  return busy ? [...BUSY, ...OWN_BUSY[kind]] : [...IDLE, ...OWN[kind]];
}

/** A random move for `kind`, never `last` again straight away. */
export function nextMove(
  kind: Kind,
  busy: boolean,
  last: MoveId | null,
  random: () => number = Math.random
): MoveId {
  const pool = movesFor(kind, busy).filter((m) => m !== last);
  return pool[Math.floor(random() * pool.length)] ?? pool[0] ?? "blink";
}

/** How long until the next move: idle, every 6–13 s; working, every 2.5–5.5 s. */
export function nextDelay(busy: boolean, random: () => number = Math.random) {
  return busy ? 2500 + random() * 3000 : 6000 + random() * 7000;
}

/** A mascot's faces: one shows at a time (`data-face`). */
export type FaceId =
  | "happy"
  | "curious"
  | "thinking"
  | "surprised"
  | "sleepy"
  | "wink"
  | "laugh"
  | "puzzled";

/** The face a trick wears; a trick not named keeps the face it found. */
const MOVE_FACE: Partial<Record<MoveId, FaceId>> = {
  aha: "laugh",
  doze: "sleepy",
  giggle: "laugh",
  glitch: "surprised",
  glow: "happy",
  hop: "laugh",
  "look-around": "curious",
  nod: "happy",
  orbit: "happy",
  peek: "curious",
  ponder: "puzzled",
  shiver: "puzzled",
  sparkle: "happy",
  spin: "surprised",
  surprise: "surprised",
  tilt: "curious",
  twirl: "laugh",
  wink: "wink",
};

/** The faces it drifts between while idle, the happy one most. */
const IDLE_FACES: readonly FaceId[] = [
  "happy",
  "happy",
  "happy",
  "curious",
  "puzzled",
];

/** The face to show: a trick's own, else thinking while Claude works, else
 *  the idle face of the moment. */
export function faceFor(
  move: MoveId | null,
  busy: boolean,
  idleFace: FaceId
): FaceId {
  return (move && MOVE_FACE[move]) || (busy ? "thinking" : idleFace);
}

/** The next idle face: a change from `last`. */
export function nextIdleFace(
  last: FaceId,
  random: () => number = Math.random
): FaceId {
  const pool = IDLE_FACES.filter((f) => f !== last);
  return pool[Math.floor(random() * pool.length)] ?? "happy";
}
