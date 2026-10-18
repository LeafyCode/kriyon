import { expect, test } from "vitest";
import {
  faceFor,
  MOVE_MS,
  movesFor,
  nextDelay,
  nextIdleFace,
  nextMove,
} from "./mascotMoves.ts";

const KINDS = ["gem", "visor", "hex"] as const;

test("each one has plenty of shared tricks and its own", () => {
  for (const kind of KINDS) {
    expect(movesFor(kind, false).length).toBeGreaterThan(12);
  }
  expect(movesFor("gem", false)).toContain("sparkle");
  expect(movesFor("visor", false)).toContain("scan");
  expect(movesFor("hex", false)).toContain("twirl");
  expect(movesFor("gem", false)).not.toContain("scan");
});

test("while Claude works they think: no dozing, no capers", () => {
  for (const kind of KINDS) {
    const busy = movesFor(kind, true);
    expect(busy).toContain("aha");
    expect(busy).toContain("ponder");
    for (const caper of ["doze", "hop", "spin", "shiver", "peek", "giggle"]) {
      expect(busy).not.toContain(caper);
    }
  }
});

test("a move never plays twice in a row, and every move has a length", () => {
  for (let i = 0; i < 50; i += 1) {
    expect(nextMove("visor", false, "hop", () => i / 50)).not.toBe("hop");
  }
  for (const kind of KINDS) {
    for (const move of movesFor(kind, false)) {
      expect(MOVE_MS[move]).toBeGreaterThan(0);
    }
  }
});

test("working, the moves come sooner", () => {
  expect(nextDelay(true, () => 1)).toBeLessThan(nextDelay(false, () => 0));
});

test("each trick wears its own face, else it thinks while Claude works", () => {
  expect(faceFor("surprise", false, "happy")).toBe("surprised");
  expect(faceFor("doze", false, "happy")).toBe("sleepy");
  expect(faceFor("aha", true, "happy")).toBe("laugh");
  expect(faceFor(null, true, "curious")).toBe("thinking");
  expect(faceFor(null, false, "curious")).toBe("curious");
  expect(faceFor("blink", false, "puzzled")).toBe("puzzled");
});

test("an idle face change is a change", () => {
  for (let i = 0; i < 20; i += 1) {
    expect(nextIdleFace("curious", () => i / 20)).not.toBe("curious");
  }
});
