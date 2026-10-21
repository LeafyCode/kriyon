import { render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { HEADLINE, Hero } from "./Hero.tsx";

const LEAFY_CODE_INTERNATIONAL = /LEAFY CODE INTERNATIONAL/;
const SANDBOX_CLAIM = /desktop app|sandbox/i;
const PLATFORM = /mac|windows|linux/i;
const DOWNLOAD = /DOWNLOAD FOR MAC/;

test("the headline is the tagline, with no platform in it", () => {
  // Kriyon is Mac-only today but not by design; the tagline must outlive that.
  render(<Hero />);
  const h1 = screen.getByRole("heading", { level: 1 });

  expect(h1.textContent).toBe(HEADLINE);
  expect(h1.textContent).not.toMatch(PLATFORM);
});

test("makes no claim about how other Claude apps run Claude Code", () => {
  // Softened on purpose: the page says what Kriyon does, not what others limit.
  const { container } = render(<Hero />);
  expect(container.textContent).not.toMatch(SANDBOX_CLAIM);
});

test("credits Leafy Code International by its full name", () => {
  render(<Hero />);
  const credit = screen.getByRole("link", { name: LEAFY_CODE_INTERNATIONAL });
  expect(credit.getAttribute("href")).toBe("https://leafycode.com/");
});

test("the download button fetches the newest DMG, whatever its version", () => {
  render(<Hero />);
  const download = screen.getByRole("link", { name: DOWNLOAD });

  expect(download.getAttribute("href")).toBe(
    "https://github.com/LeafyCode/kriyon/releases/latest/download/Kriyon.dmg"
  );
});
