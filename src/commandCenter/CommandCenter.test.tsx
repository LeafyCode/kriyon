import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";
import { useCommandCenter } from "../state/commandCenter.ts";
import { DEFAULT_LAYOUT, useLayout } from "../state/layout.ts";
import { type UiSession, useSessions } from "../state/sessions.ts";
import type { ProjectRow } from "../types.ts";
import { CommandCenter } from "./CommandCenter.tsx";

function makeProject(id: string): ProjectRow {
  return {
    color: null,
    id,
    name: `Project ${id}`,
    path: `/${id}`,
    parkedAt: null,
    setupCommand: null,
  };
}

function makeSession(
  id: string,
  projectId: string,
  status: UiSession["status"]
): UiSession {
  return {
    archivedAt: null,
    baselineOid: null,
    claudeSessionId: null,
    createdAt: 1,
    cwd: "",
    id,
    projectId,
    status,
    summary: "",
    title: `Title ${id}`,
    titleLocked: false,
    worktreePath: null,
  };
}

beforeEach(() => {
  vi.useRealTimers();
  useSessions.setState({
    activeSessionId: null,
    activity: {},
    events: {},
    projects: [makeProject("p1"), makeProject("p2")],
    sessions: {
      s1: makeSession("s1", "p1", "waiting"),
      s2: makeSession("s2", "p2", "running"),
    },
  });
  useLayout.setState({ layout: { ...DEFAULT_LAYOUT, view: "command" } });
  useCommandCenter.setState({ lastSeenMs: {}, lastChangeMs: {} });
});

test("fills the shell's main area rather than shrinking to its content", () => {
  // Since ADR-0023 the shell is a ROW, and this view is one of its flex
  // children. `height: 100%` was the main axis under the old column shell and
  // is the cross axis now, so without an explicit grow this view would stop at
  // its widest standing row. jsdom does no layout — only the declaration can
  // be pinned here.
  render(<CommandCenter />);
  expect(screen.getByTestId("command-center")).toHaveStyle({
    flex: "1",
    minWidth: "0px",
  });
});

test("a waiting session appears in the Needs-you rail", () => {
  const now = Date.now();
  useCommandCenter.setState({ lastSeenMs: { s1: now, s2: now } });
  render(<CommandCenter />);

  const rail = screen.getByTestId("needs-you");
  expect(rail).toHaveTextContent("Title s1");
  // A running session is not blocked on the user.
  expect(rail).not.toHaveTextContent("Title s2");
});

test("a stale-watcher session renders state unknown, not idle", () => {
  // s2 has a fresh heartbeat; s1's last-seen is far in the past → unknown.
  const now = Date.now();
  useCommandCenter.setState({ lastSeenMs: { s1: now - 60_000, s2: now } });
  render(<CommandCenter />);

  const stateLabel = screen.getByTestId("standing-state-s1");
  expect(stateLabel).toHaveTextContent("Unknown");
  expect(stateLabel).not.toHaveTextContent("Idle");
});

test("standings are grouped by project", () => {
  const now = Date.now();
  useCommandCenter.setState({ lastSeenMs: { s1: now, s2: now } });
  render(<CommandCenter />);

  const p1 = screen.getByTestId("standing-group-p1");
  const p2 = screen.getByTestId("standing-group-p2");
  expect(p1).toHaveTextContent("Project p1");
  expect(p2).toHaveTextContent("Project p2");
  expect(screen.getByTestId("standing-s1")).toBeInTheDocument();
  expect(screen.getByTestId("standing-s2")).toBeInTheDocument();
});

test("clicking a standing activates the session and returns to the studio layout", () => {
  const now = Date.now();
  useCommandCenter.setState({ lastSeenMs: { s1: now, s2: now } });
  render(<CommandCenter />);

  fireEvent.click(screen.getByTestId("standing-s2"));

  expect(useSessions.getState().activeSessionId).toBe("s2");
  expect(useLayout.getState().layout.view).toBe("studio");
});

test("clicking a standing from Focus stays in Focus", () => {
  const now = Date.now();
  useCommandCenter.setState({ lastSeenMs: { s1: now, s2: now } });
  render(<CommandCenter />);
  // Reachable: the Command centre is one of the Focus rail's view tiles, so
  // the user can be sent here and back without ever leaving Focus.
  useLayout.setState((state) => ({
    layout: { ...state.layout, view: "focus" },
  }));

  fireEvent.click(screen.getByTestId("standing-s2"));

  expect(useSessions.getState().activeSessionId).toBe("s2");
  expect(useLayout.getState().layout.view).toBe("focus");
});

test("the notify-preference control reflects and updates the store", () => {
  const now = Date.now();
  useCommandCenter.setState({ lastSeenMs: { s1: now, s2: now } });
  render(<CommandCenter />);

  fireEvent.click(screen.getByRole("tab", { name: "Off" }));
  expect(useLayout.getState().layout.notifyPreference).toBe("none");
});

test("a rail entry shows the exact ask, blocked duration, and project", () => {
  const now = Date.now();
  useCommandCenter.setState({
    lastChangeMs: { s1: now - 5 * 60_000 },
    lastSeenMs: { s1: now, s2: now },
  });
  useSessions.setState((state) => ({
    activity: {
      ...state.activity,
      s1: {
        main: { currentTool: null },
        pendingAsk: {
          askedAt: new Date(now - 12 * 60_000).toISOString(),
          kind: "question",
          text: "Which db?",
        },
        shells: [],
        subagents: [],
        tasks: [],
      },
    },
  }));
  render(<CommandCenter />);
  expect(screen.getByTestId("needs-you-ask-s1").textContent).toContain(
    "Which db?"
  );
  expect(screen.getByTestId("needs-you-blocked-s1").textContent).toBe("12m");
});

test("without an exact ask the rail entry shows the assistant snippet", () => {
  const now = Date.now();
  useCommandCenter.setState({ lastSeenMs: { s1: now, s2: now } });
  useSessions.setState((state) => ({
    events: {
      ...state.events,
      s1: [{ id: "1:0", kind: "assistant", text: "Should I use worktrees?" }],
    },
  }));
  render(<CommandCenter />);
  expect(screen.getByTestId("needs-you-ask-s1").textContent).toContain(
    "Should I use worktrees?"
  );
});

test("opening an entry with an exact ask routes to the raw view", () => {
  const now = Date.now();
  useCommandCenter.setState({ lastSeenMs: { s1: now, s2: now } });
  useSessions.setState((state) => ({
    activity: {
      ...state.activity,
      s1: {
        main: { currentTool: null },
        pendingAsk: { askedAt: null, kind: "permission", text: "Bash" },
        shells: [],
        subagents: [],
        tasks: [],
      },
    },
  }));
  useLayout.setState((state) => ({
    layout: { ...state.layout, transcriptView: "raw" },
  }));
  render(<CommandCenter />);
  fireEvent.click(screen.getByTestId("needs-you-s1"));
  expect(useSessions.getState().activeSessionId).toBe("s1");
  const layoutState = useLayout.getState();
  expect(layoutState.layout.view).toBe("studio");
  expect(layoutState.layout.transcriptView).toBe("raw");
});
