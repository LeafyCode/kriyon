import { describe, expect, test } from "vitest";
import { placeCard, spotlightRect } from "./placement.ts";

const viewport = { height: 800, width: 1200 };
const card = { height: 200, width: 320 };

describe("placeCard", () => {
  test("with no target the card sits in the middle of the window", () => {
    expect(placeCard(null, card, viewport, "right")).toEqual({
      left: 440,
      side: "center",
      top: 300,
    });
  });

  test("places the card on the preferred side, centred on the target", () => {
    const target = { height: 100, left: 20, top: 300, width: 200 };
    expect(placeCard(target, card, viewport, "right")).toEqual({
      left: 234,
      side: "right",
      top: 250,
    });
  });

  test("flips to the opposite side when the preferred side has no room", () => {
    const target = { height: 100, left: 1000, top: 300, width: 180 };
    const placed = placeCard(target, card, viewport, "right");
    expect(placed.side).toBe("left");
    expect(placed.left).toBe(1000 - 14 - 320);
  });

  test("keeps the card inside the window margins", () => {
    const target = { height: 40, left: 20, top: 760, width: 200 };
    const placed = placeCard(target, card, viewport, "right");
    expect(placed.top).toBe(800 - 16 - 200);
  });

  test("a target too big for any side gets the card centred over it", () => {
    const target = { height: 800, left: 0, top: 0, width: 1200 };
    expect(placeCard(target, card, viewport, "bottom").side).toBe("center");
  });
});

describe("spotlightRect", () => {
  test("pads the target and keeps it on screen", () => {
    expect(
      spotlightRect({ height: 20, left: 2, top: 2, width: 50 }, viewport)
    ).toEqual({ height: 28, left: 0, top: 0, width: 58 });
  });

  test("with no target the spotlight closes to a point in the middle", () => {
    expect(spotlightRect(null, viewport)).toEqual({
      height: 0,
      left: 600,
      top: 400,
      width: 0,
    });
  });
});
