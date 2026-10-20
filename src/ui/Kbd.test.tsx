import { render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { Kbd } from "./Kbd.tsx";

test("renders its children inside a kbd element", () => {
  render(<Kbd>⌘⇧P</Kbd>);
  const cap = screen.getByText("⌘⇧P");
  expect(cap.tagName).toBe("KBD");
});
