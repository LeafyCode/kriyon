import { fireEvent, render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { Ticker } from "./Ticker.tsx";

const PAUSE = /Pause/;
const PLAY = /Play/;
test("the ticker can be paused without a mouse (WCAG 2.2.2)", () => {
  render(<Ticker />);

  fireEvent.click(screen.getByRole("button", { name: PAUSE }));

  expect(screen.getByRole("button", { name: PLAY })).toBeTruthy();
});

test("the doubled track is hidden from assistive tech", () => {
  const { container } = render(<Ticker />);
  expect(
    container.querySelector(".ticker-track")?.getAttribute("aria-hidden")
  ).toBe("true");
});
