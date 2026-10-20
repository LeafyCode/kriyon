import { render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { Footer } from "./Footer.tsx";

const DISCLAIMER =
  "Kriyon is an independent open-source project. It is not affiliated with, endorsed by, or sponsored by Anthropic. Claude and Claude Code are trademarks of Anthropic, PBC. Kriyon runs your own, unmodified Claude Code install; you sign in through Anthropic's own flow and your use is governed by your agreement with Anthropic.";

test("the footer carries the full Anthropic disclaimer", () => {
  render(<Footer />);

  expect(screen.getByText(DISCLAIMER)).toBeTruthy();
});

test("the footer credits Leafy Code International", () => {
  render(<Footer />);

  expect(
    screen.getByRole("link", { name: "LEAFY CODE INTERNATIONAL" })
  ).toBeTruthy();
});
