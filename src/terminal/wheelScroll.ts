/**
 * Wheel-scroll normalization shared by the terminal's two scroll paths (xterm
 * scrollback and mouse-tracking TUIs). The problem it solves: a mouse wheel
 * emits a few large, discrete "notch" deltas, while a trackpad emits dozens of
 * tiny, continuous pixel deltas per gesture. Amplifying every event (the old
 * fixed ×3) makes the mouse feel snappy but sends the trackpad flying.
 *
 * So we split the two: a coarse mouse notch scrolls a fixed number of lines
 * (snappy), while a fine trackpad delta is accumulated in pixels and converted
 * to whole line-steps at the cell height (natural, ~Warp-like). Pure so the
 * classification and the pixel→line folding are unit-tested without the DOM.
 */

/** The wheel fields the classifier needs (a subset of `WheelEvent`). */
export interface WheelSample {
  /** 0 = pixel, 1 = line, 2 = page. */
  deltaMode: number;
  deltaY: number;
  /** WebKit/Blink legacy field; a physical wheel notch is a multiple of 120. */
  wheelDeltaY?: number;
}

/** Classic mouse-wheel delta quantum in WebKit/Blink `wheelDelta` units. */
const WHEEL_NOTCH_UNIT = 120;
/** Below this many pixels a same-frame delta reads as a trackpad, not a notch. */
const NOTCH_MIN_PX = 40;

/**
 * Whether a wheel event is fine-grained (trackpad / precise surface) rather than
 * a discrete mouse-wheel notch. Line/page mode is always a classic wheel. In
 * pixel mode, WebKit/Blink expose `wheelDeltaY`: a physical notch is a whole
 * multiple of 120, so anything else is a trackpad. Without that field, small or
 * fractional pixel deltas read as a trackpad.
 */
export function isFineScroll(sample: WheelSample): boolean {
  if (sample.deltaMode !== 0) {
    return false;
  }
  const wd = sample.wheelDeltaY;
  if (typeof wd === "number" && wd !== 0) {
    return Math.abs(wd) % WHEEL_NOTCH_UNIT !== 0;
  }
  return (
    !Number.isInteger(sample.deltaY) || Math.abs(sample.deltaY) < NOTCH_MIN_PX
  );
}

/**
 * The escape sequence one wheel line-step sends to an alternate-screen app that
 * has NOT grabbed the mouse (`less`, `man`, `git log`). The alt buffer has no
 * scrollback, so `scrollLines` is a no-op there — the terminal convention
 * (iTerm, Terminal.app) is to translate the wheel into arrow keys instead. The
 * form tracks DECCKM: CSI arrows normally, SS3 when application cursor keys are
 * on (which full-screen pagers usually set).
 */
export function arrowKeyReport(
  up: boolean,
  applicationCursor: boolean
): string {
  const direction = up ? "A" : "B";
  return applicationCursor ? `\x1bO${direction}` : `\x1b[${direction}`;
}

/** The xterm modes {@link readsArrowsAsScroll} reasons about. */
export interface AltScreenModes {
  bracketedPasteMode: boolean;
}

/**
 * Whether an alternate-screen app that has NOT grabbed the mouse will read the
 * arrow keys {@link arrowKeyReport} sends as *scrolling*.
 *
 * The translation was written for pagers — `less`, `man`, `git log` — where the
 * screen is all there is and ↑/↓ move it. It is wrong, and destructively so,
 * for a full-screen app with a text input: there ↑/↓ walk the history or move
 * the caret, so a wheel gesture silently replaces what the user typed. Claude
 * Code's fullscreen renderer run with `CLAUDE_CODE_DISABLE_MOUSE=1` is exactly
 * that shape — alternate screen, no mouse capture, a prompt at the bottom
 * (ADR-0024).
 *
 * Bracketed paste is the discriminator, and the only one the terminal actually
 * exposes. An app enables DECSET 2004 because it has somewhere for pasted text
 * to *go*; a pager has nothing to paste into and never asks for it. So
 * bracketed paste on means "there is an input line here", which is precisely
 * the case where the arrow keys are input rather than navigation.
 *
 * It is a heuristic, not a fact about which program is running — the escape
 * sequences never say that. It is chosen so that the failure mode is a wheel
 * that does nothing (the user scrolls with PgUp/PgDn, which is what Claude's
 * own documentation tells them to do in this configuration) rather than a wheel
 * that eats a half-written prompt.
 */
export function readsArrowsAsScroll(modes: AltScreenModes): boolean {
  return !modes.bracketedPasteMode;
}

/** A carried pixel remainder for {@link foldLineSteps}. */
export interface WheelAccumulator {
  remainder: number;
}

/**
 * Fold a trackpad pixel delta into whole line-steps at `linePx` per line,
 * carrying the sub-line remainder so a slow glide still scrolls smoothly. The
 * remainder resets on a direction reversal so flicking back responds at once.
 * Returns the signed number of line-steps to scroll now (0 while accumulating).
 */
export function foldLineSteps(
  acc: WheelAccumulator,
  deltaPx: number,
  linePx: number
): number {
  if (deltaPx === 0 || linePx <= 0) {
    return 0;
  }
  if (acc.remainder !== 0 && Math.sign(deltaPx) !== Math.sign(acc.remainder)) {
    acc.remainder = 0;
  }
  acc.remainder += deltaPx;
  const steps = Math.trunc(acc.remainder / linePx);
  acc.remainder -= steps * linePx;
  return steps;
}
