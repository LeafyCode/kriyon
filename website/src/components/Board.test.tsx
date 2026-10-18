import { render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { Board } from "./Board.tsx";

test("the clock renders a constant before any tick, so SSR and hydration agree", () => {
  // The one hydration hazard on this page: seeding from `new Date()` would make
  // the server's HTML and the client's first render disagree every single load.
  render(<Board />);
  expect(screen.getByText("00:00:00")).toBeTruthy();
});

test("the board is idle until it scrolls into view", () => {
  // With the stubbed IntersectionObserver nothing ever intersects, so neither
  // interval may start — the wait timers must still read their seeded values.
  render(<Board />);
  expect(screen.getByText("04:12")).toBeTruthy();
  expect(screen.getByText("11:40")).toBeTruthy();
});
