import { fireEvent, render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { Hero } from "./Hero.tsx";

const PAUSE = /pause/i;
const PLAY = /play/i;
const CLAUDES = /Claudes/i;
const SESSIONS_HEADLINE = /Run ten\s*Claude Code\s*sessions\./i;
const USAGE_LINE =
  /All sessions use your own Claude plan and its usage limits\./;

test("the ticker offers a pause control reachable without a mouse (WCAG 2.2.2)", () => {
  render(<Hero />);
  const button = screen.getByRole("button", { name: PAUSE });

  fireEvent.click(button);
  expect(screen.getByRole("button", { name: PLAY })).toBeTruthy();
});

test("the ticker strip itself is hidden from assistive tech", () => {
  // Every claim it scrolls past is made in prose elsewhere on the page, and it
  // is duplicated for the seamless loop — announcing it would read twice.
  const { container } = render(<Hero />);
  expect(
    container.querySelector(".ticker-track")?.getAttribute("aria-hidden")
  ).toBe("true");
});

test("the headline counts Claude Code sessions, never 'Claudes'", () => {
  render(<Hero />);
  const title = screen.getByRole("heading", { level: 1 }).textContent ?? "";

  expect(title).not.toMatch(CLAUDES);
  expect(title).toMatch(SESSIONS_HEADLINE);
});

test("says every session spends the user's own plan", () => {
  render(<Hero />);

  expect(screen.getByText(USAGE_LINE)).toBeTruthy();
});
