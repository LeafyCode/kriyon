import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, test } from "vitest";
import { useChanges } from "../state/changes.ts";
import { DEFAULT_LAYOUT, useLayout } from "../state/layout.ts";
import { idleSession, type UiSession, useSessions } from "../state/sessions.ts";
import { useUi } from "../state/ui.ts";
import type { SessionStatus, StudioEvent } from "../types.ts";
import { TurnRecapCard } from "./TurnRecapCard.tsx";

const events: StudioEvent[] = [
  { id: "p1", kind: "prompt", text: "fix it" },
  {
    additions: 1,
    deletions: 0,
    file: "src/app/login.ts",
    hunk: "",
    id: "d1",
    kind: "diff",
    lines: [],
  },
  { cmd: "pnpm test", exit: 0, id: "b1", kind: "bash", output: [] },
  { id: "a1", kind: "assistant", text: "Login is fixed and tests pass." },
];

function seed(status: SessionStatus): void {
  useSessions.setState({
    activeSessionId: "s1",
    activity: {},
    events: { s1: events },
    sessions: {
      s1: {
        ...idleSession({
          archivedAt: null,
          baselineOid: null,
          claudeSessionId: null,
          createdAt: 1,
          cwd: "/repo",
          id: "s1",
          projectId: "p1",
          title: "Login",
          titleLocked: false,
          worktreePath: null,
        }),
        status,
      },
    },
  });
}

beforeEach(() => {
  useLayout.setState({ layout: DEFAULT_LAYOUT });
  useUi.setState({ spawnOpen: false, spawnPredecessorId: null });
});
afterEach(cleanup);

test("when Claude stops, the recap says what the turn did and its last line", () => {
  seed("done");
  render(<TurnRecapCard />);
  const card = screen.getByTestId("turn-recap");
  expect(card).toHaveTextContent("Changed 1 file · ran 1 command");
  expect(card).toHaveTextContent("Login is fixed and tests pass.");
  expect(card).toHaveTextContent("login.ts");
});

test("follow up opens the spawn dialog from this session; review opens Changes", () => {
  seed("done");
  render(<TurnRecapCard />);
  fireEvent.click(screen.getByRole("button", { name: "Follow up" }));
  expect(useUi.getState().spawnPredecessorId).toBe("s1");
  fireEvent.click(screen.getByRole("button", { name: "Review changes" }));
  expect(useLayout.getState().layout.transcriptView).toBe("changes");
});

test("closing hides this turn's recap; none shows while Claude works", () => {
  seed("done");
  render(<TurnRecapCard />);
  fireEvent.click(screen.getByRole("button", { name: "Close the recap" }));
  expect(screen.queryByTestId("turn-recap")).not.toBeInTheDocument();
  act(() => {
    useSessions.setState((s) => ({
      events: {
        s1: [
          ...events,
          { id: "p2", kind: "prompt", text: "again" },
          { cmd: "ls", exit: 0, id: "b2", kind: "bash", output: [] },
        ],
      },
      sessions: { s1: { ...(s.sessions.s1 as UiSession), status: "running" } },
    }));
  });
  expect(screen.queryByTestId("turn-recap")).not.toBeInTheDocument();
  act(() => {
    useSessions.setState((s) => ({
      sessions: { s1: { ...(s.sessions.s1 as UiSession), status: "done" } },
    }));
  });
  expect(screen.getByTestId("turn-recap")).toHaveTextContent("Ran 1 command");
});

test("Review changes shows when Claude changed files through the shell, not its edit tools", () => {
  seed("done");
  useSessions.setState({
    events: {
      s1: [
        { id: "p-shell", kind: "prompt", text: "add square" },
        {
          cmd: "cat > src/math.js",
          exit: 0,
          id: "b1",
          kind: "bash",
          output: [],
        },
        { id: "a1", kind: "assistant", text: "Done." },
      ],
    },
  });
  render(<TurnRecapCard />);
  expect(
    screen.queryByRole("button", { name: "Review changes" })
  ).not.toBeInTheDocument();

  cleanup();
  useChanges.setState((state) => ({
    bySession: {
      ...state.bySession,
      s1: {
        ...state.bySession.s1,
        totals: { additions: 8, deletions: 0, files: 2 },
      },
    },
  }));
  render(<TurnRecapCard />);
  expect(screen.getByRole("button", { name: "Review changes" })).toBeVisible();
});
