import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { computeTotalsFromFiles, useChanges } from "../state/changes.ts";
import type { FileDiff } from "../types.ts";
import { SummaryBar } from "./SummaryBar.tsx";

function fileWithOneAddition(path: string): FileDiff {
  return {
    binary: false,
    hunks: [
      {
        header: "@@ -0,0 +1,1 @@",
        lines: [{ kind: "added", text: "new" }],
      },
    ],
    oldPath: null,
    path,
    status: "added",
  };
}

const AGO_RE = /ago/;

describe("SummaryBar", () => {
  beforeEach(() => {
    useChanges.setState({ bySession: {} });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows totals and the baseline label from the store", () => {
    useChanges.setState({
      bySession: {
        s1: {
          baselineLabel: "main @ abc1234",
          collapsed: {},
          diff: null,
          fetchedAt: Date.now(),
          hunkHashes: {},
          status: "ready",
          totals: { additions: 59, deletions: 11, files: 4 },
          viewed: {},
        },
      },
    });

    render(<SummaryBar onRefresh={vi.fn()} sessionId="s1" />);

    expect(screen.getByTestId("summary-totals")).toHaveTextContent(
      "4 files changed"
    );
    expect(screen.getByTestId("summary-totals")).toHaveTextContent("+59");
    expect(screen.getByTestId("summary-totals")).toHaveTextContent("−11");
    expect(screen.getByTestId("summary-baseline")).toHaveTextContent(
      "main @ abc1234"
    );
  });

  it("I5 (round-two review, BLOCKER): prints the totals it is handed, instead of the store's (unfiltered) entry.totals", () => {
    useChanges.setState({
      bySession: {
        s1: {
          baselineLabel: "HEAD · uncommitted",
          collapsed: {},
          diff: null,
          fetchedAt: Date.now(),
          hunkHashes: {},
          status: "ready",
          // Deliberately unfiltered/stale-looking relative to the `totals`
          // prop below — proves the header reads what the [Changes view
          // model] resolved for the on-screen list, not this.
          totals: { additions: 300, deletions: 40, files: 12 },
          viewed: {},
        },
      },
    });

    render(
      <SummaryBar
        onRefresh={vi.fn()}
        sessionId="s1"
        totals={computeTotalsFromFiles([fileWithOneAddition("a.ts")])}
      />
    );

    expect(screen.getByTestId("summary-totals")).toHaveTextContent(
      "1 file changed"
    );
    expect(screen.getByTestId("summary-totals")).toHaveTextContent("+1");
    expect(screen.getByTestId("summary-totals")).not.toHaveTextContent(
      "12 files"
    );
  });

  it("falls back to the store's entry.totals when no totals are given (filter off)", () => {
    useChanges.setState({
      bySession: {
        s1: {
          baselineLabel: "HEAD · uncommitted",
          collapsed: {},
          diff: null,
          fetchedAt: Date.now(),
          hunkHashes: {},
          status: "ready",
          totals: { additions: 59, deletions: 11, files: 4 },
          viewed: {},
        },
      },
    });

    render(<SummaryBar onRefresh={vi.fn()} sessionId="s1" />);

    expect(screen.getByTestId("summary-totals")).toHaveTextContent(
      "4 files changed"
    );
  });

  it("calls onRefresh when the refresh button is clicked", () => {
    const onRefresh = vi.fn();
    useChanges.setState({
      bySession: {
        s1: {
          baselineLabel: "HEAD · uncommitted",
          collapsed: {},
          diff: null,
          fetchedAt: Date.now(),
          hunkHashes: {},
          status: "ready",
          totals: { additions: 1, deletions: 0, files: 1 },
          viewed: {},
        },
      },
    });

    render(<SummaryBar onRefresh={onRefresh} sessionId="s1" />);
    fireEvent.click(screen.getByTestId("summary-refresh"));

    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it("disables the refresh button while loading", () => {
    useChanges.setState({
      bySession: {
        s1: {
          baselineLabel: "HEAD · uncommitted",
          collapsed: {},
          diff: null,
          fetchedAt: Date.now(),
          hunkHashes: {},
          status: "loading",
          totals: null,
          viewed: {},
        },
      },
    });

    render(<SummaryBar onRefresh={vi.fn()} sessionId="s1" />);

    expect(screen.getByTestId("summary-refresh")).toBeDisabled();
  });

  it("shows an 'updated Xs ago' label once the fetch is more than 10s stale", () => {
    useChanges.setState({
      bySession: {
        s1: {
          baselineLabel: "HEAD · uncommitted",
          collapsed: {},
          diff: null,
          fetchedAt: Date.now() - 15_000,
          hunkHashes: {},
          status: "ready",
          totals: { additions: 0, deletions: 0, files: 0 },
          viewed: {},
        },
      },
    });

    render(<SummaryBar onRefresh={vi.fn()} sessionId="s1" />);

    expect(screen.getByTestId("summary-stale")).toHaveTextContent(AGO_RE);
  });

  it("hides the stale label within the first 10s after a fetch", () => {
    useChanges.setState({
      bySession: {
        s1: {
          baselineLabel: "HEAD · uncommitted",
          collapsed: {},
          diff: null,
          fetchedAt: Date.now(),
          hunkHashes: {},
          status: "ready",
          totals: { additions: 0, deletions: 0, files: 0 },
          viewed: {},
        },
      },
    });

    render(<SummaryBar onRefresh={vi.fn()} sessionId="s1" />);

    expect(screen.queryByTestId("summary-stale")).not.toBeInTheDocument();
  });

  it("renders gracefully for a session with no diff loaded yet", () => {
    render(<SummaryBar onRefresh={vi.fn()} sessionId="unknown" />);

    expect(screen.getByTestId("summary-bar")).toBeInTheDocument();
  });

  it("does not schedule a live tick when there is nothing to tick for (no fetch yet)", () => {
    vi.useFakeTimers();

    render(<SummaryBar isVisible onRefresh={vi.fn()} sessionId="unknown" />);

    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not schedule a live tick when the view isn't visible", () => {
    vi.useFakeTimers();
    useChanges.setState({
      bySession: {
        s1: {
          baselineLabel: "HEAD · uncommitted",
          collapsed: {},
          diff: null,
          fetchedAt: Date.now(),
          hunkHashes: {},
          status: "ready",
          totals: { additions: 0, deletions: 0, files: 0 },
          viewed: {},
        },
      },
    });

    render(<SummaryBar isVisible={false} onRefresh={vi.fn()} sessionId="s1" />);

    expect(vi.getTimerCount()).toBe(0);
  });

  it("schedules a live tick once visible with something to tick for", () => {
    vi.useFakeTimers();
    useChanges.setState({
      bySession: {
        s1: {
          baselineLabel: "HEAD · uncommitted",
          collapsed: {},
          diff: null,
          fetchedAt: Date.now(),
          hunkHashes: {},
          status: "ready",
          totals: { additions: 0, deletions: 0, files: 0 },
          viewed: {},
        },
      },
    });

    render(<SummaryBar isVisible onRefresh={vi.fn()} sessionId="s1" />);

    expect(vi.getTimerCount()).toBeGreaterThan(0);
  });

  it("stops ticking once the view is no longer visible", () => {
    vi.useFakeTimers();
    useChanges.setState({
      bySession: {
        s1: {
          baselineLabel: "HEAD · uncommitted",
          collapsed: {},
          diff: null,
          fetchedAt: Date.now(),
          hunkHashes: {},
          status: "ready",
          totals: { additions: 0, deletions: 0, files: 0 },
          viewed: {},
        },
      },
    });

    const { rerender } = render(
      <SummaryBar isVisible onRefresh={vi.fn()} sessionId="s1" />
    );
    expect(vi.getTimerCount()).toBeGreaterThan(0);

    rerender(
      <SummaryBar isVisible={false} onRefresh={vi.fn()} sessionId="s1" />
    );

    expect(vi.getTimerCount()).toBe(0);
  });

  it("ticks the 'updated Xs ago' label live as time passes, with no re-render forced from outside", () => {
    vi.useFakeTimers();
    useChanges.setState({
      bySession: {
        s1: {
          baselineLabel: "HEAD · uncommitted",
          collapsed: {},
          diff: null,
          fetchedAt: Date.now(),
          hunkHashes: {},
          status: "ready",
          totals: { additions: 0, deletions: 0, files: 0 },
          viewed: {},
        },
      },
    });

    render(<SummaryBar onRefresh={vi.fn()} sessionId="s1" />);

    // Fresh: no stale label yet.
    expect(screen.queryByTestId("summary-stale")).not.toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(15_000);
    });
    expect(screen.getByTestId("summary-stale")).toHaveTextContent("15s ago");

    // The clock keeps ticking without any prop/store change forcing it.
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(screen.getByTestId("summary-stale")).toHaveTextContent("20s ago");
  });

  it("does not pulse by default", () => {
    useChanges.setState({
      bySession: {
        s1: {
          baselineLabel: "HEAD · uncommitted",
          collapsed: {},
          diff: null,
          fetchedAt: Date.now(),
          hunkHashes: {},
          status: "ready",
          totals: { additions: 0, deletions: 0, files: 0 },
          viewed: {},
        },
      },
    });

    render(<SummaryBar onRefresh={vi.fn()} sessionId="s1" />);

    expect(screen.getByTestId("summary-bar")).toHaveAttribute(
      "data-pulsing",
      "false"
    );
  });

  it("collapse all dispatches setAllCollapsed(sessionId, true)", () => {
    useChanges.setState({
      bySession: {
        s1: {
          baselineLabel: "HEAD · uncommitted",
          collapsed: {},
          diff: {
            base: "HEAD",
            files: [fileWithOneAddition("a.ts"), fileWithOneAddition("b.ts")],
          },
          fetchedAt: Date.now(),
          hunkHashes: {},
          status: "ready",
          totals: { additions: 2, deletions: 0, files: 2 },
          viewed: {},
        },
      },
    });

    render(<SummaryBar onRefresh={vi.fn()} sessionId="s1" />);
    fireEvent.click(screen.getByTestId("summary-collapse-all"));

    const { collapsed } = useChanges.getState().bySession.s1 ?? {};
    expect(collapsed?.["a.ts"]).toBe(true);
    expect(collapsed?.["b.ts"]).toBe(true);
  });

  it("expand all dispatches setAllCollapsed(sessionId, false)", () => {
    useChanges.setState({
      bySession: {
        s1: {
          baselineLabel: "HEAD · uncommitted",
          collapsed: { "a.ts": true, "b.ts": true },
          diff: {
            base: "HEAD",
            files: [fileWithOneAddition("a.ts"), fileWithOneAddition("b.ts")],
          },
          fetchedAt: Date.now(),
          hunkHashes: {},
          status: "ready",
          totals: { additions: 2, deletions: 0, files: 2 },
          viewed: {},
        },
      },
    });

    render(<SummaryBar onRefresh={vi.fn()} sessionId="s1" />);
    fireEvent.click(screen.getByTestId("summary-expand-all"));

    const { collapsed } = useChanges.getState().bySession.s1 ?? {};
    expect(collapsed?.["a.ts"]).toBe(false);
    expect(collapsed?.["b.ts"]).toBe(false);
  });

  it("flags itself as pulsing via data-pulsing when told a silent refresh just landed", () => {
    useChanges.setState({
      bySession: {
        s1: {
          baselineLabel: "HEAD · uncommitted",
          collapsed: {},
          diff: null,
          fetchedAt: Date.now(),
          hunkHashes: {},
          status: "ready",
          totals: { additions: 0, deletions: 0, files: 0 },
          viewed: {},
        },
      },
    });

    render(<SummaryBar onRefresh={vi.fn()} pulsing sessionId="s1" />);

    expect(screen.getByTestId("summary-bar")).toHaveAttribute(
      "data-pulsing",
      "true"
    );
  });
});

it("collapse and expand are left out while a file is open instead of the diff", () => {
  render(
    <SummaryBar
      diffControls={false}
      onRefresh={() => undefined}
      sessionId="s1"
    />
  );
  expect(screen.queryByTestId("summary-collapse-all")).not.toBeInTheDocument();
  expect(screen.queryByTestId("summary-expand-all")).not.toBeInTheDocument();
  expect(screen.getByTestId("summary-refresh")).toBeInTheDocument();
});

describe("the redesigned bar", () => {
  beforeEach(() => {
    useChanges.setState({
      bySession: {
        s1: {
          baselineLabel: "session start · snapshot ac1741c",
          collapsed: {},
          comparedTo: "since session start",
          diff: null,
          fetchedAt: Date.now(),
          hunkHashes: {},
          status: "ready",
          totals: { additions: 0, deletions: 0, files: 0 },
          viewed: {},
        },
      },
    });
  });

  it("says No changes instead of a row of zeros", () => {
    render(<SummaryBar onRefresh={vi.fn()} sessionId="s1" />);
    const totals = screen.getByTestId("summary-totals");
    expect(totals).toHaveTextContent("No changes");
    expect(totals).not.toHaveTextContent("+0");
  });

  it("says what it compares against in plain words, with the snapshot in the tooltip", () => {
    render(<SummaryBar onRefresh={vi.fn()} sessionId="s1" />);
    const label = screen.getByTestId("summary-baseline");
    expect(label).toHaveTextContent("since session start");
    expect(label).not.toHaveTextContent("snapshot");
    expect(label.getAttribute("title")).toContain("ac1741c");
  });

  it("carries the Only Claude's edits switch in the same row", () => {
    const onToggle = vi.fn();
    render(
      <SummaryBar
        editsToggle={{ checked: true, onToggle }}
        onRefresh={vi.fn()}
        sessionId="s1"
      />
    );
    const toggle = screen.getByRole("switch", { name: "Only Claude's edits" });
    expect(toggle).toHaveAttribute("aria-checked", "true");
    fireEvent.click(toggle);
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it("names its icon buttons", () => {
    render(<SummaryBar onRefresh={vi.fn()} sessionId="s1" />);
    expect(
      screen.getByRole("button", { name: "Collapse all" })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Expand all" })
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Refresh" })).toBeInTheDocument();
  });
});
