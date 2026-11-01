/**
 * Where the [App tour]'s spotlight and card go. Pure geometry, so the
 * component only measures and renders.
 */

export interface Box {
  height: number;
  left: number;
  top: number;
  width: number;
}

export interface Size {
  height: number;
  width: number;
}

/** The side of its target a card prefers, or `center` for none. */
export type CardSide = "top" | "right" | "bottom" | "left";

export interface CardPlacement {
  left: number;
  side: CardSide | "center";
  top: number;
}

/** Space between the spotlight's edge and the card. */
const GAP = 14;
/** The card never comes closer than this to the window edge. */
const MARGIN = 16;
/** How far the spotlight reaches past its target. */
const PAD = 6;

const OPPOSITE: Record<CardSide, CardSide> = {
  bottom: "top",
  left: "right",
  right: "left",
  top: "bottom",
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

/** The card's spot on one side of `target`, and whether it fits there. */
function onSide(
  side: CardSide,
  target: Box,
  card: Size,
  viewport: Size
): { fits: boolean; left: number; top: number } {
  const midX = target.left + target.width / 2 - card.width / 2;
  const midY = target.top + target.height / 2 - card.height / 2;
  const clampX = (x: number) =>
    clamp(x, MARGIN, viewport.width - MARGIN - card.width);
  const clampY = (y: number) =>
    clamp(y, MARGIN, viewport.height - MARGIN - card.height);
  switch (side) {
    case "right": {
      const left = target.left + target.width + GAP;
      return {
        fits: left + card.width <= viewport.width - MARGIN,
        left,
        top: clampY(midY),
      };
    }
    case "left": {
      const left = target.left - GAP - card.width;
      return { fits: left >= MARGIN, left, top: clampY(midY) };
    }
    case "bottom": {
      const top = target.top + target.height + GAP;
      return {
        fits: top + card.height <= viewport.height - MARGIN,
        left: clampX(midX),
        top,
      };
    }
    default: {
      const top = target.top - GAP - card.height;
      return { fits: top >= MARGIN, left: clampX(midX), top };
    }
  }
}

/**
 * Put the card beside `target`: on `preferred` if it fits, else the opposite
 * side, else either of the other two, else over the middle of the target.
 * With no target the card sits in the middle of the window.
 */
export function placeCard(
  target: Box | null,
  card: Size,
  viewport: Size,
  preferred: CardSide
): CardPlacement {
  const area = target ?? {
    height: viewport.height,
    left: 0,
    top: 0,
    width: viewport.width,
  };
  if (target) {
    const order: CardSide[] = [
      preferred,
      OPPOSITE[preferred],
      ...(["right", "bottom", "left", "top"] as const).filter(
        (side) => side !== preferred && side !== OPPOSITE[preferred]
      ),
    ];
    for (const side of order) {
      const spot = onSide(side, target, card, viewport);
      if (spot.fits) {
        return { left: spot.left, side, top: spot.top };
      }
    }
  }
  return {
    left: clamp(
      area.left + area.width / 2 - card.width / 2,
      MARGIN,
      viewport.width - MARGIN - card.width
    ),
    side: "center",
    top: clamp(
      area.top + area.height / 2 - card.height / 2,
      MARGIN,
      viewport.height - MARGIN - card.height
    ),
  };
}

/**
 * The lit hole around `target`, padded and kept on screen. With no target it
 * closes to a point in the middle, so moving to or from a step without one
 * animates instead of jumping.
 */
export function spotlightRect(target: Box | null, viewport: Size): Box {
  if (!target) {
    return {
      height: 0,
      left: viewport.width / 2,
      top: viewport.height / 2,
      width: 0,
    };
  }
  const left = Math.max(0, target.left - PAD);
  const top = Math.max(0, target.top - PAD);
  const right = Math.min(viewport.width, target.left + target.width + PAD);
  const bottom = Math.min(viewport.height, target.top + target.height + PAD);
  return { height: bottom - top, left, top, width: right - left };
}
