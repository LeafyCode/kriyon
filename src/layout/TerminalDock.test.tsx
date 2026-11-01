import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../terminal/TerminalWorkspace.tsx", () => ({
  TerminalWorkspace: ({
    cwd,
    scope,
    visible,
  }: {
    cwd: string;
    scope: string | null;
    visible: boolean;
  }) => (
    <div
      data-cwd={cwd}
      data-project={scope ?? "none"}
      data-testid="workspace"
      data-visible={String(visible)}
    />
  ),
}));

import { DEFAULT_LAYOUT, useLayout } from "../state/layout.ts";
import { useSessions } from "../state/sessions.ts";
import { terminalScope, useTerminals } from "../state/terminals.ts";
import { TerminalDock } from "./TerminalDock.tsx";

function session(id: string, projectId: string) {
  return {
    archivedAt: null,
    baselineOid: null,
    claudeSessionId: null,
    createdAt: 1,
    cwd: "/repo",
    id,
    projectId,
    status: "idle" as const,
    summary: "",
    title: id,
    titleLocked: false,
    worktreePath: null,
  };
}

function project(id: string, path: string) {
  return {
    color: null,
    id,
    name: id,
    path,
    setupCommand: null,
  };
}

beforeEach(() => {
  useLayout.setState({ layout: { ...DEFAULT_LAYOUT } });
  useSessions.setState({ activeSessionId: null, projects: [], sessions: {} });
  useTerminals.setState({ busyPanes: {}, byScope: {} });
});

describe("TerminalDock", () => {
  it("opens new terminals in the active session's worktree", () => {
    useLayout.setState({
      layout: { ...DEFAULT_LAYOUT, terminalDockOpen: true },
    });
    useSessions.setState({
      activeSessionId: "s1",
      projects: [project("p1", "/repo")],
      sessions: {
        s1: { ...session("s1", "p1"), worktreePath: "/repo-worktrees/feat" },
      },
    });

    render(<TerminalDock />);
    expect(screen.getByTestId("workspace").dataset.cwd).toBe(
      "/repo-worktrees/feat"
    );
  });

  it("shows a worktree session only its own worktree's terminals", () => {
    const wt = terminalScope("p1", "/repo-worktrees/feat");
    useLayout.setState({
      layout: { ...DEFAULT_LAYOUT, terminalDockOpen: true },
    });
    useSessions.setState({
      activeSessionId: "wt",
      projects: [project("p1", "/repo")],
      sessions: {
        main: session("main", "p1"),
        wt: { ...session("wt", "p1"), worktreePath: "/repo-worktrees/feat" },
      },
    });
    useTerminals.getState().openTab("p1", "/repo");

    render(<TerminalDock />);
    // The main folder's terminals stay mounted but hidden; the worktree's
    // own (still empty) workspace is the visible one.
    expect(screen.getByTestId("scope-pane-p1").style.display).toBe("none");
    expect(screen.getByTestId(`scope-pane-${wt}`).style.display).toBe("block");
  });

  it("shows a main-folder session none of a worktree's terminals", () => {
    const wt = terminalScope("p1", "/repo-worktrees/feat");
    useLayout.setState({
      layout: { ...DEFAULT_LAYOUT, terminalDockOpen: true },
    });
    useSessions.setState({
      activeSessionId: "main",
      projects: [project("p1", "/repo")],
      sessions: {
        main: session("main", "p1"),
        wt: { ...session("wt", "p1"), worktreePath: "/repo-worktrees/feat" },
      },
    });
    useTerminals.getState().openTab(wt, "/repo-worktrees/feat");

    render(<TerminalDock />);
    expect(screen.getByTestId(`scope-pane-${wt}`).style.display).toBe("none");
    expect(screen.getByTestId("scope-pane-p1").style.display).toBe("block");
  });

  it("opens new terminals in the project folder for a main-folder session", () => {
    useLayout.setState({
      layout: { ...DEFAULT_LAYOUT, terminalDockOpen: true },
    });
    useSessions.setState({
      activeSessionId: "s1",
      projects: [project("p1", "/repo")],
      sessions: { s1: session("s1", "p1") },
    });

    render(<TerminalDock />);
    expect(screen.getByTestId("workspace").dataset.cwd).toBe("/repo");
  });

  it("renders nothing when the dock is closed and no project has terminals", () => {
    const { container } = render(<TerminalDock />);
    expect(container.firstChild).toBeNull();
  });

  it("keeps workspaces mounted (hidden) when the dock closes with terminals open", () => {
    useLayout.setState({
      layout: { ...DEFAULT_LAYOUT, terminalDockOpen: true },
    });
    useSessions.setState({
      activeSessionId: "s1",
      projects: [project("p1", "/a")],
      sessions: { s1: session("s1", "p1") },
    });
    useTerminals.getState().openTab("p1", "/a");

    const { container, rerender } = render(<TerminalDock />);
    expect(screen.getByTestId("workspace")).toBeTruthy();

    // Close the dock: the workspace must stay mounted so the running
    // terminal is not disposed — only hidden.
    useLayout.setState({
      layout: { ...DEFAULT_LAYOUT, terminalDockOpen: false },
    });
    rerender(<TerminalDock />);

    const workspace = screen.getByTestId("workspace");
    expect(workspace).toBeTruthy();
    expect(workspace.getAttribute("data-visible")).toBe("false");
    expect((container.firstChild as HTMLElement).style.display).toBe("none");
  });

  it("renders the workspace when the dock is open", () => {
    useLayout.setState({
      layout: { ...DEFAULT_LAYOUT, terminalDockOpen: true },
    });
    render(<TerminalDock />);
    expect(screen.getByTestId("workspace")).toBeTruthy();
  });

  it("keeps a workspace mounted per project, showing only the active one", () => {
    useLayout.setState({
      layout: { ...DEFAULT_LAYOUT, terminalDockOpen: true },
    });
    useSessions.setState({
      activeSessionId: "s1",
      projects: [project("p1", "/a"), project("p2", "/b")],
      sessions: { s1: session("s1", "p1"), s2: session("s2", "p2") },
    });
    // Both projects have opened terminals in a previous switch.
    useTerminals.getState().openTab("p1", "/a");
    useTerminals.getState().openTab("p2", "/b");

    render(<TerminalDock />);
    const panes = screen.getAllByTestId("workspace");
    const byScope = new Map(
      panes.map((el) => [el.getAttribute("data-project"), el])
    );
    // Every project with terminals stays mounted so switching never loses one.
    expect(byScope.has("p1")).toBe(true);
    expect(byScope.has("p2")).toBe(true);
    // Only the active project's workspace is visible; the other is hidden alive.
    expect(byScope.get("p1")?.getAttribute("data-visible")).toBe("true");
    expect(byScope.get("p2")?.getAttribute("data-visible")).toBe("false");
    expect(screen.getByTestId("scope-pane-p2").style.display).toBe("none");
    expect(screen.getByTestId("scope-pane-p1").style.display).not.toBe("none");
  });

  it("unmounts a fully parked project's terminals so no shell restarts behind its back", () => {
    useLayout.setState({
      layout: { ...DEFAULT_LAYOUT, terminalDockOpen: true },
    });
    useSessions.setState({
      activeSessionId: "s1",
      projects: [project("p1", "/a"), project("p2", "/b")],
      sessions: {
        s1: session("s1", "p1"),
        s2: { ...session("s2", "p2"), parkedAt: 10 },
      },
    });
    useTerminals.getState().openTab("p1", "/a");
    useTerminals.getState().openTab("p2", "/b");

    render(<TerminalDock />);

    expect(screen.getByTestId("scope-pane-p1")).toBeTruthy();
    expect(screen.queryByTestId("scope-pane-p2")).toBeNull();
  });

  it("mounts the active project's workspace even before it has any tabs", () => {
    useLayout.setState({
      layout: { ...DEFAULT_LAYOUT, terminalDockOpen: true },
    });
    useSessions.setState({
      activeSessionId: "s1",
      projects: [project("p1", "/a")],
      sessions: { s1: session("s1", "p1") },
    });
    render(<TerminalDock />);
    expect(screen.getByTestId("scope-pane-p1")).toBeTruthy();
    expect(screen.getByTestId("workspace").getAttribute("data-project")).toBe(
      "p1"
    );
  });
});
