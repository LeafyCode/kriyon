import { act, fireEvent, render, screen } from "@testing-library/react";
import { Profiler } from "react";
import { beforeEach, expect, test, vi } from "vitest";
import App, { SessionPane } from "./App.tsx";
import { DEFAULT_INTEGRATION_PREFS } from "./ipc/bridge.ts";
import { launchActiveSession } from "./state/actions.ts";
import { useIntegration } from "./state/integration.ts";
import { DEFAULT_LAYOUT, useLayout } from "./state/layout.ts";
import { type UiSession, useSessions } from "./state/sessions.ts";
import { registerScreenText } from "./terminal/screenText.ts";
import type { PendingAsk } from "./types.ts";

// The pane's heavy leaves are irrelevant to render scoping; stub them so the
// test exercises only SessionPane's own subscriptions.
vi.mock("./terminal/Terminal.tsx", () => ({
  Terminal: () => <div data-testid="term" />,
}));
vi.mock("./changes/ChangesView.tsx", () => ({
  ChangesView: () => <div data-testid="changes" />,
}));
vi.mock("./structured/StructuredView.tsx", () => ({
  StructuredView: () => <div data-testid="structured" />,
}));

// App-level: the session launch is what consent gates, so watch it; and keep
// hydration from replacing the seeded store.
vi.mock("./state/actions.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./state/actions.ts")>()),
  launchActiveSession: vi.fn(() => Promise.resolve(true)),
}));
vi.mock("./state/persistence.ts", () => ({
  hydrate: vi.fn(() => Promise.resolve()),
  installPersistence: vi.fn(() => () => {
    // Nothing installed.
  }),
}));

function makeSession(id: string): UiSession {
  return {
    archivedAt: null,
    baselineOid: null,
    claudeSessionId: null,
    createdAt: 1,
    cwd: "",
    id,
    projectId: "p1",
    status: "idle",
    summary: "",
    title: id,
    titleLocked: false,
    worktreePath: null,
  };
}

beforeEach(() => {
  useSessions.setState({
    warmPanes: [],
    activeSessionId: null,
    activity: {},
    events: {},
    projects: [],
    sessions: {},
    touchedFiles: {},
    usage: {},
  });
  useLayout.setState({ layout: DEFAULT_LAYOUT });
});

test("only an activated session's pane mounts its terminal (pty)", () => {
  const state = useSessions.getState();
  state.addSession(makeSession("s1"));
  state.addSession(makeSession("s2"));
  state.setActiveSession("s1");

  // A background session that was never the active tab must not spin up its
  // pty on boot — that is what made every session "resume" at once.
  const bg = render(<SessionPane sessionId="s2" />);
  expect(bg.queryByTestId("term")).toBeNull();

  // The active session mounts its terminal so `claude` can run there.
  const fg = render(<SessionPane sessionId="s1" />);
  expect(fg.queryByTestId("term")).not.toBeNull();
});

test("a pane keeps its terminal after it stops being active (keep-alive)", () => {
  const state = useSessions.getState();
  state.addSession(makeSession("s1"));
  state.addSession(makeSession("s2"));
  state.setActiveSession("s1");

  const { queryByTestId } = render(<SessionPane sessionId="s2" />);
  expect(queryByTestId("term")).toBeNull();

  // First activation mounts the terminal…
  act(() => {
    useSessions.getState().setActiveSession("s2");
  });
  expect(queryByTestId("term")).not.toBeNull();

  // …and switching away keeps it mounted (remounting blanks xterm).
  act(() => {
    useSessions.getState().setActiveSession("s1");
  });
  expect(queryByTestId("term")).not.toBeNull();
});

test("the transcript view is display-toggled, never conditionally unmounted", () => {
  const state = useSessions.getState();
  state.addSession(makeSession("s1"));
  state.setActiveSession("s1");
  useLayout.getState().setTranscriptView("changes");

  const { getByTestId } = render(<SessionPane sessionId="s1" />);

  // Both panes are in the DOM at once (Changes joins the Terminal keep-alive
  // pattern) — a remount would blank the terminal and would refetch the diff
  // feed, losing scroll position.
  const term = getByTestId("term");
  const changes = getByTestId("changes");

  // Only the selected view is actually shown; the other is display:none, not
  // absent from the tree.
  expect(changes.parentElement).toHaveStyle({ display: "block" });
  expect(term.parentElement).toHaveStyle({ display: "none" });

  act(() => {
    useLayout.getState().setTranscriptView("raw");
  });
  expect(getByTestId("changes").parentElement).toHaveStyle({
    display: "none",
  });
  expect(getByTestId("term").parentElement).toHaveStyle({
    display: "block",
  });
});

test("a session pane re-renders on its own change, not another session's tick", () => {
  const state = useSessions.getState();
  state.addSession(makeSession("s1"));
  state.addSession(makeSession("s2"));
  state.setActiveSession("s1");

  let renders = 0;
  render(
    <Profiler
      id="pane"
      onRender={() => {
        renders += 1;
      }}
    >
      <SessionPane sessionId="s1" />
    </Profiler>
  );
  const afterMount = renders;

  // Another session's status tick must not re-render s1's pane.
  act(() => {
    useSessions.getState().applyStatus("s2", "running", "busy");
  });
  expect(renders).toBe(afterMount);

  // s1's own change does re-render its pane.
  act(() => {
    useSessions.getState().applyBootEvent("s1", "launch");
  });
  expect(renders).toBe(afterMount + 1);
});

test("a cold session's pane mounts neither its terminal nor its Changes diff", () => {
  const state = useSessions.getState();
  state.addSession(makeSession("s1"));
  state.addSession(makeSession("s2"));
  state.setActiveSession("s1");

  // Every mounted pane keeps its whole terminal and diff feed in the DOM.
  // Unbounded, that is one document holding every session at once — measured at
  // 15.1M characters across 93 panes on a real install, which turns any
  // WebKit whole-document pass (editor state, spellcheck, find) into a
  // multi-second stall. Cold panes mount nothing; the warm set stays the bound.
  const cold = render(<SessionPane sessionId="s2" />);

  expect(cold.queryByTestId("term")).toBeNull();
  expect(cold.queryByTestId("changes")).toBeNull();
});

test("a warm pane keeps its terminal and Changes mounted after it stops being active", () => {
  const state = useSessions.getState();
  state.addSession(makeSession("s1"));
  state.addSession(makeSession("s2"));
  state.setActiveSession("s1");

  const { queryByTestId } = render(<SessionPane sessionId="s2" />);
  expect(queryByTestId("changes")).toBeNull();

  act(() => {
    useSessions.getState().setActiveSession("s2");
  });
  expect(queryByTestId("term")).not.toBeNull();
  expect(queryByTestId("changes")).not.toBeNull();

  // Switching away keeps them: losing diff-feed scroll position on every tab
  // switch is exactly what the keep-alive rule exists to prevent.
  act(() => {
    useSessions.getState().setActiveSession("s1");
  });
  expect(queryByTestId("term")).not.toBeNull();
  expect(queryByTestId("changes")).not.toBeNull();
});

function askFor(id: string, pendingAsk: PendingAsk | null): void {
  act(() => {
    useSessions.setState((state) => ({
      activity: {
        ...state.activity,
        [id]: {
          main: { currentTool: null },
          pendingAsk,
          shells: [],
          subagents: [],
          tasks: [],
        },
      },
    }));
  });
}

const BACK = /back to structured/i;
const ANSWER = /answer/i;

const QUESTION: PendingAsk = {
  askedAt: null,
  kind: "question",
  text: "Which db?",
};

test("in the Structured view, Claude Code's dialog shows its own terminal until answered", () => {
  const state = useSessions.getState();
  state.addSession(makeSession("s1"));
  state.setActiveSession("s1");
  useLayout.getState().setTranscriptView("structured");
  render(<SessionPane sessionId="s1" />);
  // Laid out though unseen, so its grid matches the CLI's and its screen reads.
  expect(screen.getByTestId("term").parentElement).toHaveStyle({
    display: "block",
    visibility: "hidden",
  });

  askFor("s1", QUESTION);
  // The real terminal, over the view: the dialog is answered where it is.
  expect(screen.getByTestId("term").parentElement).toHaveStyle({
    visibility: "visible",
  });
  expect(screen.getByTestId("structured")).toBeInTheDocument();
  // A detour, not a switch: the user's view stays the Structured one.
  expect(useLayout.getState().layout.transcriptView).toBe("structured");

  askFor("s1", null);
  expect(screen.getByTestId("term").parentElement).toHaveStyle({
    visibility: "hidden",
  });
});

test("a dialog put aside leaves a way back to it", () => {
  const state = useSessions.getState();
  state.addSession(makeSession("s1"));
  state.setActiveSession("s1");
  useLayout.getState().setTranscriptView("structured");
  render(<SessionPane sessionId="s1" />);
  askFor("s1", QUESTION);

  fireEvent.click(screen.getByRole("button", { name: BACK }));
  expect(screen.getByTestId("term").parentElement).toHaveStyle({
    visibility: "hidden",
  });

  fireEvent.click(screen.getByRole("button", { name: ANSWER }));
  expect(screen.getByTestId("term").parentElement).toHaveStyle({
    visibility: "visible",
  });
});

test("a slash command's menu on screen shows the terminal too", () => {
  vi.useFakeTimers();
  try {
    const state = useSessions.getState();
    state.addSession(makeSession("s1"));
    state.setActiveSession("s1");
    useLayout.getState().setTranscriptView("structured");
    let rows = ["❯ ", "  ? for shortcuts"];
    const unregister = registerScreenText("s1", () => rows);
    render(<SessionPane sessionId="s1" />);
    expect(screen.getByTestId("term").parentElement).toHaveStyle({
      visibility: "hidden",
    });

    rows = ["  Manage MCP servers", " ↑/↓ to navigate · Esc to cancel"];
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(screen.getByTestId("term").parentElement).toHaveStyle({
      visibility: "visible",
    });
    unregister();
  } finally {
    vi.useRealTimers();
  }
});

test("the Raw view needs no detour for a dialog", () => {
  const state = useSessions.getState();
  state.addSession(makeSession("s1"));
  state.setActiveSession("s1");
  render(<SessionPane sessionId="s1" />);
  askFor("s1", QUESTION);
  expect(screen.queryByRole("button", { name: BACK })).toBeNull();
});

test("without consent the welcome screen shows and no session launches", async () => {
  useSessions.getState().addSession(makeSession("s1"));
  useSessions.getState().setActiveSession("s1");
  useIntegration.setState({
    error: null,
    load: () => Promise.resolve(),
    status: {
      companionDir: null,
      originalStatusLine: null,
      prefs: { ...DEFAULT_INTEGRATION_PREFS, consented: false },
      companionAvailable: true,
      plannedReason: "plugin",
      plannedRoute: "plugin",
      route: "off",
      routeReason: "off",
      sideload: "allowed",
    },
  });

  render(<App />);
  await act(() => Promise.resolve());

  expect(screen.getByTestId("welcome-screen")).toBeInTheDocument();
  expect(launchActiveSession).not.toHaveBeenCalled();
});
