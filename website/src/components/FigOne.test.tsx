import { act, fireEvent, render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { controlledIntersection } from "../test/intersection.ts";
import { FigOne } from "./FigOne.tsx";

const PAUSE = /PAUSE/;
const PLAY = /PLAY/;

function figure(container: HTMLElement) {
  return container.querySelector(".fig1");
}

test("FIG. 1 waits off screen, showing the sketch rather than an empty frame", () => {
  controlledIntersection();
  const { container } = render(<FigOne />);

  expect(figure(container)?.getAttribute("data-playing")).toBe("false");
  // `data-started="false"` is what makes the CSS show the whole sketch.
  expect(figure(container)?.getAttribute("data-started")).toBe("false");
});

test("FIG. 1 plays on screen and stops again when scrolled away", () => {
  const io = controlledIntersection();
  const { container } = render(<FigOne />);

  act(() => io.scrollIntoView());
  expect(figure(container)?.getAttribute("data-playing")).toBe("true");
  expect(figure(container)?.getAttribute("data-started")).toBe("true");

  act(() => io.scrollAway());
  expect(figure(container)?.getAttribute("data-playing")).toBe("false");
});

test("FIG. 1 can be paused without a mouse (WCAG 2.2.2)", () => {
  const io = controlledIntersection();
  const { container } = render(<FigOne />);
  act(() => io.scrollIntoView());

  fireEvent.click(screen.getByRole("button", { name: PAUSE }));

  expect(figure(container)?.getAttribute("data-playing")).toBe("false");
  fireEvent.click(screen.getByRole("button", { name: PLAY }));
  expect(figure(container)?.getAttribute("data-playing")).toBe("true");
});
