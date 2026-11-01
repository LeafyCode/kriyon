import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_LAYOUT, useLayout } from "../state/layout.ts";
import { useSessions } from "../state/sessions.ts";
import { terminalScope, useTerminals } from "../state/terminals.ts";
import { TerminalToggle } from "./TerminalToggle.tsx";

function session(id: string, worktreePath: string | null) {
  return {
    archivedAt: null,
    baselineOid: null,
    claudeSessionId: null,
    createdAt: 1,
    cwd: "/repo",
    id,
    projectId: "p1",
    status: "idle" as const,
    summary: "",
    title: id,
    titleLocked: false,
    worktreePath,
  };
}

const WT = "/repo-worktrees/feat";

beforeEach(() => {
  useLayout.setState({ layout: { ...DEFAULT_LAYOUT } });
  useTerminals.setState({ busyPanes: {}, byScope: {}, deadPanes: {} });
  useSessions.setState({
    activeSessionId: "main",
    projects: [
      { color: null, id: "p1", name: "p1", path: "/repo", setupCommand: null },
    ],
    sessions: { main: session("main", null), wt: session("wt", WT) },
  });
  const t = useTerminals.getState();
  const tab = t.openTab("p1", "/repo");
  t.splitPane("p1", tab, "/repo");
  t.openTab(terminalScope("p1", WT, "/repo"), WT);
});

describe("TerminalToggle", () => {
  it("counts only the main folder's terminals in a main-folder session", () => {
    render(<TerminalToggle />);
    expect(screen.getByRole("button").textContent).toBe("2");
  });

  it("counts only the worktree's terminals in a worktree session", () => {
    useSessions.setState({ activeSessionId: "wt" });
    render(<TerminalToggle />);
    expect(screen.getByRole("button").textContent).toBe("1");
  });

  it("pulses only for a busy terminal in the current folder", () => {
    const wtPane =
      useTerminals.getState().byScope[terminalScope("p1", WT, "/repo")]?.tabs[0]
        ?.panes[0]?.id ?? "";
    useTerminals.getState().setPaneBusy(wtPane, true);
    render(<TerminalToggle />);
    expect(screen.getByRole("button").title).toBe("Terminals");
  });
});
