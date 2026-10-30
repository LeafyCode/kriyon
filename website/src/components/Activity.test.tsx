import { fireEvent, render, screen, within } from "@testing-library/react";
import { expect, test } from "vitest";
import { Activity } from "./Activity.tsx";

const ALL = /--all/;
const CHANGES_3 = /--changes · 3/;
function bodyRows() {
  const [, body] = screen.getAllByRole("rowgroup");
  return within(body).getAllByRole("row");
}

test("starts on --all, with every row shown", () => {
  render(<Activity />);
  expect(
    screen.getByRole("button", { name: ALL }).getAttribute("aria-pressed")
  ).toBe("true");
  expect(bodyRows()).toHaveLength(8);
});

test("a flag filters the table and says so", () => {
  render(<Activity />);
  const changes = screen.getByRole("button", { name: CHANGES_3 });

  fireEvent.click(changes);

  expect(changes.getAttribute("aria-pressed")).toBe("true");
  expect(bodyRows()).toHaveLength(3);
  expect(screen.queryByText("Ran the tests")).toBeNull();
});
