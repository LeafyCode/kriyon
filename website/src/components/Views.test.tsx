import { fireEvent, render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { Views } from "./Views.tsx";

const THE_ACTIVITY_TAB = /The Activity tab/;
const SESSION = /--session/;
const THE_SESSION_TAB = /The Session tab/;
test("opens on the Activity view", () => {
  render(<Views />);
  expect(screen.getByAltText(THE_ACTIVITY_TAB)).toBeTruthy();
});

test("picking a view swaps in its screenshot", () => {
  render(<Views />);

  fireEvent.click(screen.getByRole("button", { name: SESSION }));

  expect(screen.getByAltText(THE_SESSION_TAB)).toBeTruthy();
  expect(screen.queryByAltText(THE_ACTIVITY_TAB)).toBeNull();
});
