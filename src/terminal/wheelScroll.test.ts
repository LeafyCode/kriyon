import { describe, expect, it } from "vitest";
import {
  arrowKeyReport,
  foldLineSteps,
  isFineScroll,
  readsArrowsAsScroll,
} from "./wheelScroll.ts";

describe("isFineScroll", () => {
  it("treats line/page mode as a mouse wheel", () => {
    expect(isFineScroll({ deltaMode: 1, deltaY: 3 })).toBe(false);
    expect(isFineScroll({ deltaMode: 2, deltaY: 1 })).toBe(false);
  });

  it("uses wheelDeltaY: a multiple of 120 is a notch, else a trackpad", () => {
    // Physical notches (WebKit -120, a fast spin -240) are coarse.
    expect(isFineScroll({ deltaMode: 0, deltaY: 100, wheelDeltaY: -120 })).toBe(
      false
    );
    expect(isFineScroll({ deltaMode: 0, deltaY: 200, wheelDeltaY: -240 })).toBe(
      false
    );
    // A trackpad's small, non-120 wheelDelta is fine-grained.
    expect(isFineScroll({ deltaMode: 0, deltaY: 4, wheelDeltaY: -12 })).toBe(
      true
    );
  });

  it("falls back to magnitude/fractionality without wheelDeltaY", () => {
    expect(isFineScroll({ deltaMode: 0, deltaY: 8 })).toBe(true); // small
    expect(isFineScroll({ deltaMode: 0, deltaY: 2.5 })).toBe(true); // fractional
    expect(isFineScroll({ deltaMode: 0, deltaY: 100 })).toBe(false); // big notch
  });
});

describe("foldLineSteps", () => {
  it("accumulates sub-line pixels and emits whole steps, carrying the rest", () => {
    const acc = { remainder: 0 };
    expect(foldLineSteps(acc, 10, 16)).toBe(0); // 10px < one line
    expect(foldLineSteps(acc, 10, 16)).toBe(1); // 20px → 1 line, 4px carried
    expect(acc.remainder).toBe(4);
  });

  it("emits several line-steps for one large delta", () => {
    const acc = { remainder: 0 };
    expect(foldLineSteps(acc, 50, 16)).toBe(3); // 48px = 3 lines, 2px carried
    expect(acc.remainder).toBe(2);
  });

  it("handles negative (upward) deltas symmetrically", () => {
    const acc = { remainder: 0 };
    expect(foldLineSteps(acc, -20, 16)).toBe(-1);
    expect(acc.remainder).toBe(-4);
  });

  it("resets the remainder on a direction reversal", () => {
    const acc = { remainder: 10 }; // was scrolling down
    // A flick back up must not be delayed by the stale downward remainder.
    expect(foldLineSteps(acc, -20, 16)).toBe(-1);
    expect(acc.remainder).toBe(-4);
  });

  it("is a no-op for a zero delta or a non-positive line height", () => {
    const acc = { remainder: 7 };
    expect(foldLineSteps(acc, 0, 16)).toBe(0);
    expect(foldLineSteps(acc, 10, 0)).toBe(0);
    expect(acc.remainder).toBe(7);
  });
});

describe("arrowKeyReport", () => {
  it("emits CSI arrows in normal cursor mode", () => {
    expect(arrowKeyReport(true, false)).toBe("\x1b[A");
    expect(arrowKeyReport(false, false)).toBe("\x1b[B");
  });

  it("emits SS3 arrows when application cursor keys are on", () => {
    expect(arrowKeyReport(true, true)).toBe("\x1bOA");
    expect(arrowKeyReport(false, true)).toBe("\x1bOB");
  });
});

describe("readsArrowsAsScroll", () => {
  it("says yes for a pager: alternate screen, no text input", () => {
    // `less`, `man`, `git log` — the apps the arrow-key translation exists for.
    expect(readsArrowsAsScroll({ bracketedPasteMode: false })).toBe(true);
  });

  it("says no once the app has a text input to paste into", () => {
    // Claude Code's fullscreen renderer, vim in insert-capable state, a REPL:
    // ↑/↓ there walk history or move the caret, so a wheel that sends them
    // edits what the user typed instead of scrolling.
    expect(readsArrowsAsScroll({ bracketedPasteMode: true })).toBe(false);
  });
});
