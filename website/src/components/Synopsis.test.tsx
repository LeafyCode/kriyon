import { act, render } from "@testing-library/react";
import { expect, test } from "vitest";
import { controlledIntersection } from "../test/intersection.ts";
import { Synopsis } from "./Synopsis.tsx";

test("the install command types itself out once the terminal is on screen", () => {
  const io = controlledIntersection();
  const { container } = render(<Synopsis />);
  const term = container.querySelector(".term-lg");
  expect(term?.getAttribute("data-typing")).toBe("false");

  act(() => io.scrollIntoView());

  expect(term?.getAttribute("data-typing")).toBe("true");
});
