import { act, render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { controlledIntersection } from "../test/intersection.ts";
import { Origin } from "./Origin.tsx";

test("the landmarks paint in the first time they scroll into view, and stay", () => {
  const io = controlledIntersection();
  const { container } = render(<Origin />);
  const art = container.querySelector(".landmarks");
  expect(art?.getAttribute("data-painting")).toBe("false");

  act(() => io.scrollIntoView());
  act(() => io.scrollAway());

  expect(art?.getAttribute("data-painting")).toBe("true");
});

test("the section title comes from the section list", () => {
  render(<Origin />);
  expect(screen.getByRole("heading", { level: 2 }).textContent).toBe(
    "/made-in-sri-lanka"
  );
});

test("the caption sits outside the box the overlays are placed in", () => {
  // The orbs and train are placed in % of `.landmarks-art`; a caption inside
  // it would stretch the box and move them off the drawing.
  const { container } = render(<Origin />);

  expect(
    container.querySelector(".landmarks-art .landmarks-caption")
  ).toBeNull();
  expect(
    container.querySelector(".landmarks-art .landmarks-orb")
  ).not.toBeNull();
});
