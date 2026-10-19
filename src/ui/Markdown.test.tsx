import { render, screen, within } from "@testing-library/react";
import { expect, test } from "vitest";
import { Markdown } from "./Markdown.tsx";

const PIPE = /\|/;

test("a pipe table draws as a table with its header, cells and alignment", () => {
  render(
    <Markdown
      text={[
        "| Plate | Time / plastic |",
        "|---|--:|",
        "| 1 | 22 min, **13g** |",
        "",
        "---",
      ].join("\n")}
    />
  );
  const table = screen.getByRole("table");
  const headers = within(table).getAllByRole("columnheader");
  expect(headers.map((h) => h.textContent)).toEqual([
    "Plate",
    "Time / plastic",
  ]);
  const cells = within(table).getAllByRole("cell");
  expect(cells.map((c) => c.textContent)).toEqual(["1", "22 min, 13g"]);
  expect(cells[1]?.style.textAlign).toBe("right");
  expect(within(cells[1] as HTMLElement).getByText("13g").tagName).toBe(
    "STRONG"
  );
  expect(screen.getByRole("separator")).toBeTruthy();
  expect(screen.queryByText(PIPE)).toBeNull();
});
