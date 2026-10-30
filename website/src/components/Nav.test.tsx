import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { SECTION_IDS } from "../lib/sections.ts";
import { APP_VERSION } from "../lib/site.ts";
import { THEME_KEY } from "../lib/theme.ts";
import { Nav } from "./Nav.tsx";

const NAME = /NAME/;
const INSTALL = /§ INSTALL/;

afterEach(() => {
  document.body.innerHTML = "";
  delete document.documentElement.dataset.theme;
  localStorage.clear();
});

test("on narrow screens the sections open from one button", () => {
  render(<Nav />);
  const menu = screen.getByRole("button", { name: NAME });
  expect(menu.getAttribute("aria-expanded")).toBe("false");

  fireEvent.click(menu);

  expect(menu.getAttribute("aria-expanded")).toBe("true");
  expect(
    document.getElementById("nav-sections")?.getAttribute("data-open")
  ).toBe("true");
});

test("the theme toggle pins dark mode and remembers it", () => {
  render(<Nav />);
  const toggle = screen.getByRole("button", { name: "Dark mode" });

  fireEvent.click(toggle);

  expect(document.documentElement.dataset.theme).toBe("dark");
  expect(localStorage.getItem(THEME_KEY)).toBe("dark");
  expect(toggle.getAttribute("aria-pressed")).toBe("true");
});

test("the version badge links to the latest release", () => {
  render(<Nav />);
  // `pnpm release` rewrites APP_VERSION, so the test must not pin a number.
  const badge = screen.getByRole("link", {
    name: new RegExp(APP_VERSION.replaceAll(".", "\\.")),
  });
  expect(badge.getAttribute("href")).toBe(
    "https://github.com/LeafyCode/kriyon/releases/latest"
  );
});

test("an open menu closes on Escape and on a press outside the nav", () => {
  render(
    <>
      <Nav />
      <p>outside</p>
    </>
  );
  const menu = screen.getByRole("button", { name: NAME });

  fireEvent.click(menu);
  fireEvent.keyDown(document, { key: "Escape" });
  expect(menu.getAttribute("aria-expanded")).toBe("false");

  fireEvent.click(menu);
  fireEvent.pointerDown(screen.getByText("outside"));
  expect(menu.getAttribute("aria-expanded")).toBe("false");
});

test("past the listed sections the nav names where you are, and marks no link", () => {
  for (const id of SECTION_IDS) {
    const el = document.createElement("section");
    el.id = id;
    // Every section up to Install has scrolled past the nav; Origin has not.
    el.getBoundingClientRect = () =>
      ({ top: id === "origin" ? 800 : -100 }) as DOMRect;
    document.body.append(el);
  }

  render(<Nav />);

  expect(screen.getByRole("button", { name: INSTALL })).toBeTruthy();
  expect(document.querySelector("[aria-current]")).toBeNull();
});
