import { describe, expect, test } from "vitest";
import {
  copyBlockOutput,
  copySelection,
  reflowLines,
  type TerminalLike,
} from "./cleanCopy.ts";

interface FakeRow {
  isWrapped: boolean;
  text: string;
}

function fakeTerm(
  rows: FakeRow[],
  selection?: ReturnType<TerminalLike["getSelectionPosition"]>
): TerminalLike {
  return {
    buffer: {
      active: {
        length: rows.length,
        getLine: (y: number) => rows[y],
      },
    },
    hasSelection: () => selection !== undefined,
    getSelectionPosition: () => selection,
  };
}

describe("reflowLines", () => {
  test("rejoins soft-wrapped continuation rows into one logical line", () => {
    const term = fakeTerm([
      { isWrapped: false, text: "hello wor" },
      { isWrapped: true, text: "ld" },
      { isWrapped: false, text: "next line" },
    ]);

    expect(reflowLines(term, 0, 2)).toBe("hello world\nnext line");
  });

  test("trims trailing whitespace per logical line", () => {
    const term = fakeTerm([
      { isWrapped: false, text: "padded   " },
      { isWrapped: false, text: "tail" },
    ]);

    expect(reflowLines(term, 0, 1)).toBe("padded\ntail");
  });

  test("clamps out-of-range bounds and skips missing rows", () => {
    const term = fakeTerm([{ isWrapped: false, text: "only" }]);

    expect(reflowLines(term, -2, 10)).toBe("only");
  });
});

describe("copySelection", () => {
  test("returns empty string when there is no selection", () => {
    const term = fakeTerm([{ isWrapped: false, text: "a" }]);
    expect(copySelection(term)).toBe("");
  });

  test("reflows the selected rows", () => {
    const term = fakeTerm(
      [
        { isWrapped: false, text: "skip" },
        { isWrapped: false, text: "hello wor" },
        { isWrapped: true, text: "ld" },
      ],
      { start: { x: 0, y: 1 }, end: { x: 2, y: 2 } }
    );

    expect(copySelection(term)).toBe("hello world");
  });
});

describe("copyBlockOutput", () => {
  test("returns the unwrapped output text over the range", () => {
    const term = fakeTerm([
      { isWrapped: false, text: "$ cmd" },
      { isWrapped: false, text: "line one is very lo" },
      { isWrapped: true, text: "ng" },
      { isWrapped: false, text: "line two" },
    ]);

    expect(copyBlockOutput(term, { outputStart: 1, outputEnd: 3 })).toBe(
      "line one is very long\nline two"
    );
  });
});
