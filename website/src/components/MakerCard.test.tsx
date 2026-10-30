import { render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { MakerCard } from "./MakerCard.tsx";

const PHONE = /\+94 766 707 355/;
const STUDIO = /Pannipitiya/;

test("Leafy Code International can be reached by email, phone and map", () => {
  render(<MakerCard />);

  expect(
    screen
      .getByRole("link", { name: "hello@leafycode.com" })
      .getAttribute("href")
  ).toBe("mailto:hello@leafycode.com");
  expect(screen.getByRole("link", { name: PHONE }).getAttribute("href")).toBe(
    "tel:+94766707355"
  );
  expect(
    screen.getByRole("link", { name: STUDIO }).getAttribute("href")
  ).toContain("google.com/maps");
});
