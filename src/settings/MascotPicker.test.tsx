import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, expect, test } from "vitest";
import { DEFAULT_LAYOUT, useLayout } from "../state/layout.ts";
import { MascotPicker } from "./MascotPicker.tsx";

beforeEach(() => useLayout.setState({ layout: DEFAULT_LAYOUT }));

test("the Visor is the default; each orb can be picked, or none", () => {
  render(<MascotPicker />);
  expect(screen.getByRole("button", { name: "Visor" })).toHaveAttribute(
    "aria-pressed",
    "true"
  );
  fireEvent.click(screen.getByRole("button", { name: "Hex" }));
  expect(useLayout.getState().layout.mascot).toBe("hex");
  fireEvent.click(screen.getByRole("button", { name: "None" }));
  expect(useLayout.getState().layout.mascot).toBe("none");
  expect(screen.queryByRole("button", { name: "Teal" })).toBeNull();
});

test("its colour can be changed", () => {
  render(<MascotPicker />);
  fireEvent.click(screen.getByRole("button", { name: "Teal" }));
  expect(useLayout.getState().layout.mascotHue).toBe("teal");
});
