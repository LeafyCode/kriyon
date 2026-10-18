import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import TrayPanel from "./TrayPanel.tsx";
import type { TrayGroups } from "./trayRows.ts";

const RE_NO_SESSIONS = /No sessions running/i;
const RE_TOTALS = /2\.0 GB · 57% CPU/;
const RE_TOTALS_NO_CPU = /512 MB · — CPU/;

const groups: TrayGroups = {
  needsYou: [
    {
      ago: "2m",
      askKind: "question",
      branch: "redesign/settings-page",
      line: "💬 Approve edit to settings-page.ts?",
      pill: "APPROVE",
      sessionId: "s1",
      status: "waiting",
      title: "globex",
    },
  ],
  running: [
    {
      ago: "1m",
      askKind: null,
      branch: "tests/e2e",
      line: "Running test suite… 84/120",
      pill: null,
      sessionId: "s2",
      status: "running",
      title: "checkout-flow",
    },
  ],
};

const noop = () => undefined;
const baseProps = {
  groups,
  onNewSession: noop,
  onOpenApp: noop,
  onOpenSession: noop,
  onPreferences: noop,
};

describe("TrayPanel", () => {
  test("grouped mode shows NEEDS YOU and RUNNING section labels", () => {
    render(<TrayPanel {...baseProps} mode="grouped" />);
    expect(screen.getByText("NEEDS YOU")).toBeInTheDocument();
    expect(screen.getByText("RUNNING")).toBeInTheDocument();
    expect(screen.getByText("globex")).toBeInTheDocument();
  });

  test("compact mode shows the action pill for a needs-you row", () => {
    render(<TrayPanel {...baseProps} mode="compact" />);
    expect(screen.getByText("APPROVE")).toBeInTheDocument();
  });

  test("clicking a row calls onOpenSession with its id", () => {
    const onOpenSession = vi.fn();
    render(
      <TrayPanel {...baseProps} mode="grouped" onOpenSession={onOpenSession} />
    );
    fireEvent.click(screen.getByText("globex"));
    expect(onOpenSession).toHaveBeenCalledWith("s1");
  });

  test("the header shows the total memory and CPU across all sessions", () => {
    render(
      <TrayPanel
        {...baseProps}
        cpuTotalPct={57.2}
        memoryTotalMb={2048}
        mode="grouped"
      />
    );
    expect(screen.getByText(RE_TOTALS)).toBeInTheDocument();
  });

  test("the header CPU reads a dash before the second sample", () => {
    render(
      <TrayPanel
        {...baseProps}
        cpuTotalPct={null}
        memoryTotalMb={512}
        mode="grouped"
      />
    );
    expect(screen.getByText(RE_TOTALS_NO_CPU)).toBeInTheDocument();
  });

  test("empty groups render the empty state", () => {
    render(
      <TrayPanel
        {...baseProps}
        groups={{ needsYou: [], running: [] }}
        mode="grouped"
      />
    );
    expect(screen.getByText(RE_NO_SESSIONS)).toBeInTheDocument();
  });
});
