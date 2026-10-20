import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./highlighter.ts", () => ({
  highlightLines: vi.fn().mockReturnValue(new Promise(() => undefined)),
  // Synchronous cache peek; `undefined` keeps these tests on the async path.
  peekHighlight: vi.fn(),
  langForPath: () => "text",
}));

import type { FileDiff } from "../types.ts";
import { highlightLines } from "./highlighter.ts";
import { MAX_HIGHLIGHT_LINES, ReadOnlyFileView } from "./ReadOnlyFileView.tsx";

const mockedHighlightLines = vi.mocked(highlightLines);

describe("ReadOnlyFileView", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // @tanstack/react-virtual measures via offsetHeight/offsetWidth in jsdom,
    // which never computes layout — both default to 0 and the virtualizer
    // would render nothing without a stub.
    Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
      configurable: true,
      value: 800,
    });
    Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
      configurable: true,
      value: 600,
    });
  });

  afterEach(() => {
    // biome-ignore lint/performance/noDelete: restores jsdom's own getter.
    delete (HTMLElement.prototype as { offsetHeight?: number }).offsetHeight;
    // biome-ignore lint/performance/noDelete: restores jsdom's own getter.
    delete (HTMLElement.prototype as { offsetWidth?: number }).offsetWidth;
  });

  it("renders one row per line", () => {
    render(
      <ReadOnlyFileView content={"a\nb\nc"} fileDiff={undefined} path="f.txt" />
    );

    expect(screen.getAllByTestId("file-viewer-line")).toHaveLength(3);
  });

  it("marks the diff's added lines in the gutter", () => {
    const fileDiff: FileDiff = {
      binary: false,
      hunks: [
        {
          header: "@@ -1,1 +1,2 @@",
          lines: [
            { kind: "context", text: "a" },
            { kind: "added", text: "b" },
          ],
        },
      ],
      oldPath: null,
      path: "f.txt",
      status: "modified",
    };

    render(
      <ReadOnlyFileView content={"a\nb"} fileDiff={fileDiff} path="f.txt" />
    );

    const [line1, line2] = screen.getAllByTestId("file-viewer-line");
    // Line 2 is the added line; line 1 (context) is not marked changed.
    expect(line1).not.toHaveAttribute("data-changed");
    expect(line2).toHaveAttribute("data-changed", "true");
  });

  it("highlights the whole content, not just the visible slice", async () => {
    render(
      <ReadOnlyFileView content={"a\nb\nc"} fileDiff={undefined} path="f.txt" />
    );

    await waitFor(() => {
      expect(mockedHighlightLines).toHaveBeenCalledWith("a\nb\nc", "text");
    });
  });

  it("skips highlighting past MAX_HIGHLIGHT_LINES and renders plain text", () => {
    const big = Array.from({ length: MAX_HIGHLIGHT_LINES + 1 }, () => "x").join(
      "\n"
    );

    render(
      <ReadOnlyFileView content={big} fileDiff={undefined} path="f.txt" />
    );

    expect(mockedHighlightLines).not.toHaveBeenCalled();
  });
});
