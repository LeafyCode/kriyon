import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../terminal/TerminalWorkspace.tsx", () => ({
  TerminalWorkspace: ({
    projectId,
    visible,
  }: {
    projectId: string | null;
    visible: boolean;
  }) => (
    <div
      data-project={projectId ?? "none"}
      data-testid="workspace"
      data-visible={String(visible)}
    />
  ),
}));

import { DEFAULT_LAYOUT, useLayout } from "../state/layout.ts";
import { useSessions } from "../state/sessions.ts";
import { useTerminals } from "../state/terminals.ts";
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
  return { color: null, id, name: id, path, setupCommand: null };
}

beforeEach(() => {
  useLayout.setState({ layout: { ...DEFAULT_LAYOUT } });
  useSessions.setState({ activeSessionId: null, projects: [], sessions: {} });
  useTerminals.setState({ busyPanes: {}, byProject: {} });
});

describe("TerminalDock", () => {
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
    const byProject = new Map(
      panes.map((el) => [el.getAttribute("data-project"), el])
    );
    // Every project with terminals stays mounted so switching never loses one.
    expect(byProject.has("p1")).toBe(true);
    expect(byProject.has("p2")).toBe(true);
    // Only the active project's workspace is visible; the other is hidden alive.
    expect(byProject.get("p1")?.getAttribute("data-visible")).toBe("true");
    expect(byProject.get("p2")?.getAttribute("data-visible")).toBe("false");
    expect(screen.getByTestId("project-pane-p2").style.display).toBe("none");
    expect(screen.getByTestId("project-pane-p1").style.display).not.toBe(
      "none"
    );
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
    expect(screen.getByTestId("project-pane-p1")).toBeTruthy();
    expect(screen.getByTestId("workspace").getAttribute("data-project")).toBe(
      "p1"
    );
  });
});
