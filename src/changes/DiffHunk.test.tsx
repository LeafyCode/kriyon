import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DiffHunk as DiffHunkData, DiffLine } from "../types.ts";

const mockHighlightLines = vi.fn();

vi.mock("./highlighter.ts", () => ({
  highlightLines: (...args: [string, string]) => mockHighlightLines(...args),
  // Synchronous cache peek; `undefined` keeps these tests on the async path,
  // which is what they assert about (plain first, coloured once resolved).
  peekHighlight: () => undefined,
}));

import { DiffHunk } from "./DiffHunk.tsx";

function hunk(header: string, lines: DiffLine[]): DiffHunkData {
  return { header, lines };
}

describe("DiffHunk", () => {
  beforeEach(() => {
    mockHighlightLines.mockReset();
    // Default: never resolves during a test unless a test awaits it — most
    // numbering assertions only care about the synchronous, pre-highlight
    // render.
    mockHighlightLines.mockReturnValue(new Promise(() => undefined));
  });

  it("renders the hunk header text", () => {
    render(<DiffHunk hunk={hunk("@@ -10,3 +10,4 @@", [])} lang="text" />);
    expect(screen.getByText("@@ -10,3 +10,4 @@")).toBeInTheDocument();
  });

  it("tokenizes the old and new sides separately, never interleaved", () => {
    // The bug: every line's text was concatenated into one blob and handed to
    // the grammar, so a removed line and the added line replacing it were
    // parsed as consecutive source. A stateful construct (an unterminated
    // string, a block comment, a template literal, JSX) mis-coloured from
    // there to the end of the hunk. Neither side is valid code with the other
    // side's lines spliced into it, so they have to be tokenized apart.
    render(
      <DiffHunk
        hunk={hunk("@@ -1,3 +1,3 @@", [
          { kind: "context", text: "const a = `x" },
          { kind: "removed", text: "old`;" },
          { kind: "added", text: "new`;" },
          { kind: "context", text: "const b = 2;" },
        ])}
        lang="typescript"
      />
    );

    const codes = mockHighlightLines.mock.calls.map(([code]) => code);
    expect(codes).toContain("const a = `x\nold`;\nconst b = 2;");
    expect(codes).toContain("const a = `x\nnew`;\nconst b = 2;");
    for (const code of codes) {
      expect(code).not.toContain("old`;\nnew`;");
    }
  });

  it("tokenizes once when both sides are the same text", () => {
    // An all-context hunk (the padding around a change) has identical sides,
    // so the content-keyed highlight cache collapses them — splitting the
    // sides must not double the tokenization cost of the common case.
    render(
      <DiffHunk
        hunk={hunk("@@ -1,2 +1,2 @@", [
          { kind: "context", text: "a" },
          { kind: "context", text: "b" },
        ])}
        lang="typescript"
      />
    );

    const codes = new Set(mockHighlightLines.mock.calls.map(([code]) => code));
    expect(codes).toEqual(new Set(["a\nb"]));
  });

  it("colors each row from its own side's tokens", async () => {
    // Each side gets a distinguishable colour, so a row picking spans from
    // the wrong side (the old index/new index mix-up this guards) shows up as
    // the wrong colour rather than silently looking fine.
    const OLD = "rgb(255, 0, 0)";
    const NEW = "rgb(0, 255, 0)";
    mockHighlightLines.mockImplementation((code: string) =>
      Promise.resolve(
        code
          .split("\n")
          .map((text) => [{ color: text === "gone" ? OLD : NEW, text }])
      )
    );

    render(
      <DiffHunk
        hunk={hunk("@@ -1,2 +1,2 @@", [
          { kind: "removed", text: "gone" },
          { kind: "added", text: "kept" },
        ])}
        lang="typescript"
      />
    );

    await waitFor(() =>
      expect(screen.getByText("gone")).toHaveStyle({ color: OLD })
    );
    expect(screen.getByText("kept")).toHaveStyle({ color: NEW });
  });

  it("renders bold and italic tokens, not just colour", async () => {
    // shiki's fontStyle used to be dropped entirely, so an italic comment or a
    // bold markdown heading rendered as plain upright text.
    mockHighlightLines.mockResolvedValue([
      [
        { italic: true, text: "// note" },
        { bold: true, text: " HEAD" },
      ],
    ]);

    render(
      <DiffHunk
        hunk={hunk("@@ -1,1 +1,1 @@", [
          { kind: "context", text: "// note HEAD" },
        ])}
        lang="typescript"
      />
    );

    await waitFor(() =>
      expect(screen.getByText("// note")).toHaveStyle({ fontStyle: "italic" })
    );
    // The mono face has no 600; a bold token takes the real Bold.
    expect(screen.getByText("HEAD")).toHaveStyle({ fontWeight: "700" });
  });

  it("numbers context, removed, and added lines from the header start", () => {
    render(
      <DiffHunk
        hunk={hunk("@@ -10,3 +10,4 @@", [
          { kind: "context", text: "unchanged" },
          { kind: "removed", text: "old line" },
          { kind: "added", text: "new line" },
          { kind: "added", text: "another new" },
          { kind: "context", text: "tail" },
        ])}
        lang="text"
      />
    );

    const oldNums = screen
      .getAllByTestId("diff-old-lineno")
      .map((el) => el.textContent);
    const newNums = screen
      .getAllByTestId("diff-new-lineno")
      .map((el) => el.textContent);

    expect(oldNums).toEqual(["10", "11", "", "", "12"]);
    expect(newNums).toEqual(["10", "", "11", "12", "13"]);
  });

  it("pins old-start and new-start to their own columns on an asymmetric header", () => {
    // Old-start (40) and new-start (9) are deliberately different values —
    // a header where they happened to be equal wouldn't catch the capture
    // groups being read into the wrong column.
    render(
      <DiffHunk
        hunk={hunk("@@ -40,2 +9,2 @@", [
          { kind: "removed", text: "old first" },
          { kind: "added", text: "new first" },
        ])}
        lang="text"
      />
    );

    const oldNums = screen
      .getAllByTestId("diff-old-lineno")
      .map((el) => el.textContent);
    const newNums = screen
      .getAllByTestId("diff-new-lineno")
      .map((el) => el.textContent);

    expect(oldNums).toEqual(["40", ""]);
    expect(newNums).toEqual(["", "9"]);
  });

  it("numbers from 1 when the header is empty", () => {
    render(
      <DiffHunk
        hunk={hunk("", [
          { kind: "added", text: "a" },
          { kind: "added", text: "b" },
        ])}
        lang="text"
      />
    );

    const newNums = screen
      .getAllByTestId("diff-new-lineno")
      .map((el) => el.textContent);
    expect(newNums).toEqual(["1", "2"]);
  });

  it("numbers from 1 when the header is malformed", () => {
    render(
      <DiffHunk
        hunk={hunk("not a real hunk header", [{ kind: "context", text: "a" }])}
        lang="text"
      />
    );

    expect(screen.getByTestId("diff-old-lineno")).toHaveTextContent("1");
    expect(screen.getByTestId("diff-new-lineno")).toHaveTextContent("1");
  });

  it("renders plain text immediately, before highlighting resolves", () => {
    render(
      <DiffHunk
        hunk={hunk("@@ -1,1 +1,1 @@", [
          { kind: "context", text: "const a = 1;" },
        ])}
        lang="typescript"
      />
    );

    expect(screen.getByText("const a = 1;")).toBeInTheDocument();
  });

  it("upgrades a line's rendering in place once highlighting resolves", async () => {
    let resolveHighlight: (value: unknown) => void = () => undefined;
    mockHighlightLines.mockReturnValue(
      new Promise((resolve) => {
        resolveHighlight = resolve;
      })
    );

    render(
      <DiffHunk
        hunk={hunk("@@ -1,1 +1,1 @@", [
          { kind: "context", text: "const a = 1;" },
        ])}
        lang="typescript"
      />
    );

    expect(screen.getByText("const a = 1;")).toBeInTheDocument();

    resolveHighlight([
      [{ color: "rgb(1, 2, 3)", text: "const" }, { text: " a = 1;" }],
    ]);

    await waitFor(() => {
      expect(screen.getByText("const")).toHaveStyle({ color: "rgb(1, 2, 3)" });
    });
  });

  it("never breaks the card when highlighting rejects", async () => {
    mockHighlightLines.mockRejectedValue(new Error("boom"));

    render(
      <DiffHunk
        hunk={hunk("@@ -1,1 +1,1 @@", [
          { kind: "context", text: "still here" },
        ])}
        lang="typescript"
      />
    );

    await waitFor(() => {
      expect(mockHighlightLines).toHaveBeenCalled();
    });
    expect(screen.getByText("still here")).toBeInTheDocument();
  });
});
