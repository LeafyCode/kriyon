import { render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { CompanionChip } from "./CompanionChip.tsx";

test("the chip leaves its fill to the hover class, so hovering lights it", () => {
  render(<CompanionChip status={{ claudeVersion: "2.1.288", state: "on" }} />);
  const chip = screen.getByTestId("companion-chip");
  expect(chip.style.background).toBe("");
  expect(chip.style.getPropertyValue("--kr-fill")).not.toBe("");
});
