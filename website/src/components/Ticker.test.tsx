import { fireEvent, render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { Ticker } from "./Ticker.tsx";

const PAUSE = /Pause/;
const PLAY = /Play/;
test("the ticker can be paused without a mouse (WCAG 2.2.2)", () => {
  const { container } = render(<Ticker />);
  const strip = container.querySelector(".ticker");
  expect(strip?.getAttribute("data-paused")).toBe("false");

  fireEvent.click(screen.getByRole("button", { name: PAUSE }));

  // `data-paused` is what the CSS reads to stop the track.
  expect(strip?.getAttribute("data-paused")).toBe("true");
  expect(screen.getByRole("button", { name: PLAY })).toBeTruthy();
});

test("the doubled track is hidden from assistive tech", () => {
  const { container } = render(<Ticker />);
  expect(
    container.querySelector(".ticker-track")?.getAttribute("aria-hidden")
  ).toBe("true");
});
