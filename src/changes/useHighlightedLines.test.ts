import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./highlighter.ts", () => ({
  highlightLines: vi.fn(),
  peekHighlight: vi.fn(),
}));

import { highlightLines, peekHighlight } from "./highlighter.ts";
import { useHighlightedLines } from "./useHighlightedLines.ts";

const mockedHighlight = vi.mocked(highlightLines);
const mockedPeek = vi.mocked(peekHighlight);

describe("useHighlightedLines", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedPeek.mockReturnValue(undefined);
  });

  it("returns null until the highlight resolves, then the spans", async () => {
    const spans = [[{ color: "#fff", text: "x" }]];
    mockedHighlight.mockResolvedValue(spans);

    const { result } = renderHook(() => useHighlightedLines("x", "text"));

    expect(result.current).toBeNull();
    await waitFor(() => expect(result.current).toEqual(spans));
    expect(mockedHighlight).toHaveBeenCalledWith("x", "text");
  });

  it("skips highlighting past maxLines and stays plain (null)", () => {
    mockedHighlight.mockResolvedValue([]);

    renderHook(() => useHighlightedLines("a\nb\nc", "text", 2));

    expect(mockedHighlight).not.toHaveBeenCalled();
  });

  it("never rejects — a thrown highlight leaves it null, not an error", async () => {
    mockedHighlight.mockRejectedValue(new Error("boom"));

    const { result } = renderHook(() => useHighlightedLines("x", "text"));

    await waitFor(() => expect(mockedHighlight).toHaveBeenCalled());
    expect(result.current).toBeNull();
  });

  it("renders already-tokenized content coloured on the very first frame", () => {
    // The visible jank: virtualization unmounts and remounts hunk cards while
    // scrolling, and every remount started at null and only re-coloured a
    // microtask later — so scrolling back over content already tokenized
    // flashed it plain again, every time.
    const spans = [[{ color: "#fff", text: "x" }]];
    mockedPeek.mockReturnValue(spans);

    const { result } = renderHook(() => useHighlightedLines("x", "text"));

    expect(result.current).toEqual(spans);
    expect(mockedHighlight).not.toHaveBeenCalled();
  });

  it("re-peeks when the content changes, without a plain frame in between", () => {
    const first = [[{ color: "#111", text: "a" }]];
    const second = [[{ color: "#222", text: "b" }]];
    mockedPeek.mockImplementation((code) => (code === "a" ? first : second));

    const { result, rerender } = renderHook(
      ({ code }) => useHighlightedLines(code, "text"),
      { initialProps: { code: "a" } }
    );
    expect(result.current).toEqual(first);

    rerender({ code: "b" });

    expect(result.current).toEqual(second);
    expect(mockedHighlight).not.toHaveBeenCalled();
  });

  it("falls back to the async path when the content is not cached yet", async () => {
    const spans = [[{ color: "#fff", text: "y" }]];
    mockedPeek.mockReturnValue(undefined);
    mockedHighlight.mockResolvedValue(spans);

    const { result } = renderHook(() => useHighlightedLines("y", "text"));

    expect(result.current).toBeNull();
    await waitFor(() => expect(result.current).toEqual(spans));
  });
});
