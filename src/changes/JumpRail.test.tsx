import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useChanges } from "../state/changes.ts";
import { tokens } from "../theme/tokens.ts";
import type { FileDiff } from "../types.ts";
import { JumpRail } from "./JumpRail.tsx";

function file(path: string): FileDiff {
  return {
    binary: false,
    hunks: [
      {
        header: "@@ -1,1 +1,1 @@",
        lines: [{ kind: "context", text: "line" }],
      },
    ],
    oldPath: null,
    path,
    status: "modified",
  };
}

describe("JumpRail", () => {
  it("renders one dot per changed file", () => {
    useChanges.setState({ activeFile: {}, bySession: {} });
    render(
      <JumpRail
        files={[file("a.ts"), file("b.ts"), file("c.ts")]}
        onJumpToFile={vi.fn()}
        sessionId="s1"
      />
    );

    expect(screen.getAllByTestId("jump-rail-dot")).toHaveLength(3);
  });

  it("calls onJumpToFile with the clicked file's path", () => {
    useChanges.setState({ activeFile: {}, bySession: {} });
    const onJumpToFile = vi.fn();
    render(
      <JumpRail
        files={[file("a.ts"), file("b.ts")]}
        onJumpToFile={onJumpToFile}
        sessionId="s1"
      />
    );

    fireEvent.click(screen.getAllByTestId("jump-rail-dot")[1]);

    expect(onJumpToFile).toHaveBeenCalledWith("b.ts");
  });

  it("marks the active file's dot distinctly from the rest", () => {
    // `activeFile` now comes from the store (written by DiffFeed), not a prop,
    // so a scroll re-renders only this rail, not the whole ChangesView.
    useChanges.setState({ activeFile: { s1: "b.ts" }, bySession: {} });
    render(
      <JumpRail
        files={[file("a.ts"), file("b.ts")]}
        onJumpToFile={vi.fn()}
        sessionId="s1"
      />
    );

    const [dotA, dotB] = screen.getAllByTestId("jump-rail-dot");
    expect(dotA).toHaveAttribute("data-active", "false");
    expect(dotB).toHaveAttribute("data-active", "true");
    expect(dotB.style.background).toBe(tokens.color.accentBright);
    expect(dotA.style.background).not.toBe(tokens.color.accentBright);
    // The ring is what makes "you are here" findable on a 26px rail where
    // every other dot is the same 6px circle.
    expect(dotB.style.boxShadow).not.toBe("");
    expect(dotA.style.boxShadow).toBe("");
  });

  it("dims a viewed file's dot, distinct from an unviewed one", () => {
    useChanges.setState({
      activeFile: {},
      bySession: {
        s1: {
          baselineLabel: "",
          collapsed: {},
          diff: null,
          fetchedAt: 0,
          hunkHashes: {},
          status: "ready",
          totals: null,
          viewed: { "a.ts": true },
        },
      },
    });
    render(
      <JumpRail
        files={[file("a.ts"), file("b.ts")]}
        onJumpToFile={vi.fn()}
        sessionId="s1"
      />
    );

    const [dotA, dotB] = screen.getAllByTestId("jump-rail-dot");
    expect(dotA).toHaveAttribute("data-viewed", "true");
    expect(dotB).toHaveAttribute("data-viewed", "false");
    // Two adjacent stops on the ink ramp, deliberately not collapsed into
    // one: "already looked at" has to stay visible, just quieter than "still
    // to look at".
    expect(dotA.style.background).toBe(tokens.color.ink.faint);
    expect(dotB.style.background).toBe(tokens.color.ink.muted);
    expect(dotA.style.background).not.toBe(dotB.style.background);
  });

  it("is hidden via CSS, not unmounted, when `hidden` is set", () => {
    useChanges.setState({ activeFile: {}, bySession: {} });
    render(
      <JumpRail
        files={[file("a.ts"), file("b.ts")]}
        hidden
        onJumpToFile={vi.fn()}
        sessionId="s1"
      />
    );

    // Actually hidden (display:none), not merely present — a rail with
    // display:none can't receive real clicks, unlike one that's just
    // present but functionally inert.
    expect(screen.getByTestId("jump-rail")).toHaveStyle({ display: "none" });
    // Still in the DOM (kept mounted), so switching back doesn't lose any
    // scroll-derived state.
    expect(screen.getAllByTestId("jump-rail-dot")).toHaveLength(2);
  });

  it("gives every dot a title naming its file, for hover identification", () => {
    useChanges.setState({ activeFile: {}, bySession: {} });
    render(
      <JumpRail
        files={[file("src/deep/thing.ts")]}
        onJumpToFile={vi.fn()}
        sessionId="s1"
      />
    );

    expect(screen.getByTestId("jump-rail-dot")).toHaveAttribute(
      "title",
      "src/deep/thing.ts"
    );
  });
});
