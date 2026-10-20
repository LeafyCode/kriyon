import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";
import { useCommandCenter } from "../state/commandCenter.ts";
import { DEFAULT_LAYOUT, useLayout } from "../state/layout.ts";
import { type UiSession, useSessions } from "../state/sessions.ts";
import { useUi } from "../state/ui.ts";
import type { ProjectRow } from "../types.ts";
import { NeedsYouOverlay } from "./NeedsYouOverlay.tsx";

function makeSession(id: string, status: UiSession["status"]): UiSession {
  return {
    archivedAt: null,
    baselineOid: null,
    claudeSessionId: null,
    createdAt: 1,
    cwd: "",
    id,
    projectId: "p1",
    status,
    summary: "",
    title: `Title ${id}`,
    titleLocked: false,
    worktreePath: null,
  };
}

const project: ProjectRow = {
  color: null,
  id: "p1",
  name: "Kriyon",
  path: "/k",
  setupCommand: null,
};

beforeEach(() => {
  const now = Date.now();
  useUi.setState({ needsYouOpen: false, paletteOpen: false });
  useSessions.setState({
    activeSessionId: null,
    activity: {},
    events: {},
    projects: [project],
    sessions: {
      s1: makeSession("s1", "waiting"),
      s2: makeSession("s2", "waiting"),
    },
  });
  useLayout.setState({ layout: DEFAULT_LAYOUT });
  useCommandCenter.setState({
    lastChangeMs: { s1: now - 60_000, s2: now - 5000 },
    lastSeenMs: { s1: now, s2: now },
  });
});

test("cmd-shift-k opens the overlay listing blocked sessions", () => {
  render(<NeedsYouOverlay />);
  fireEvent.keyDown(window, { key: "K", metaKey: true, shiftKey: true });
  expect(screen.getByTestId("needs-you-overlay")).toBeTruthy();
  expect(screen.getByTestId("needs-you-s1")).toBeTruthy();
  expect(screen.getByTestId("needs-you-s2")).toBeTruthy();
});

test("arrow keys move the selection and enter opens the session", () => {
  useUi.setState({ needsYouOpen: true });
  render(<NeedsYouOverlay />);
  // s1 is blocked longest → first and selected by default; ↓ selects s2.
  fireEvent.keyDown(window, { key: "ArrowDown" });
  fireEvent.keyDown(window, { key: "Enter" });
  expect(useSessions.getState().activeSessionId).toBe("s2");
  expect(useLayout.getState().layout.view).toBe("studio");
  expect(useUi.getState().needsYouOpen).toBe(false);
});

test("enter claims the key rather than letting it reach what has focus", () => {
  // The overlay listens on `window` while sitting inside `Overlay`'s focus
  // trap, so an un-prevented Enter also activates whatever control focus is
  // on inside the panel — the session opens AND the focused button fires.
  // The other two overlays already call preventDefault here.
  useUi.setState({ needsYouOpen: true });
  render(<NeedsYouOverlay />);
  const enter = new KeyboardEvent("keydown", {
    bubbles: true,
    cancelable: true,
    key: "Enter",
  });
  window.dispatchEvent(enter);
  expect(enter.defaultPrevented).toBe(true);
});

test("installs its key listener once, not once per render", () => {
  // The effect had no dependency array, so every render tore the window
  // listener down and re-attached it. `entries` is rebuilt on each render of
  // this panel, so the churn was continuous while the overlay was open.
  useUi.setState({ needsYouOpen: true });
  const originalAdd = window.addEventListener.bind(window);
  let keydownListeners = 0;
  const spy = vi
    .spyOn(window, "addEventListener")
    .mockImplementation((type, handler, options) => {
      if (type === "keydown") {
        keydownListeners += 1;
      }
      return originalAdd(type, handler, options);
    });
  try {
    const { rerender } = render(<NeedsYouOverlay />);
    const afterMount = keydownListeners;
    rerender(<NeedsYouOverlay />);
    rerender(<NeedsYouOverlay />);
    expect(keydownListeners).toBe(afterMount);
  } finally {
    spy.mockRestore();
  }
});

test("enter from Focus opens the session without leaving Focus", () => {
  useLayout.setState((state) => ({
    layout: { ...state.layout, view: "focus" },
  }));
  useUi.setState({ needsYouOpen: true });
  render(<NeedsYouOverlay />);
  fireEvent.keyDown(window, { key: "Enter" });
  expect(useSessions.getState().activeSessionId).toBe("s1");
  expect(useLayout.getState().layout.view).toBe("focus");
});

test("escape closes the overlay", () => {
  useUi.setState({ needsYouOpen: true });
  render(<NeedsYouOverlay />);
  fireEvent.keyDown(window, { key: "Escape" });
  expect(screen.queryByTestId("needs-you-overlay")).toBeNull();
});

test("enter on an exact ask routes the raw view", () => {
  useLayout.setState({
    layout: { ...useLayout.getState().layout, transcriptView: "raw" },
  });
  useSessions.setState((state) => ({
    activity: {
      ...state.activity,
      s1: {
        main: { currentTool: null },
        pendingAsk: {
          askedAt: null,
          kind: "permission",
          text: "Run rm -rf?",
        },
        shells: [],
        subagents: [],
        tasks: [],
      },
    },
  }));
  useUi.setState({ needsYouOpen: true });
  render(<NeedsYouOverlay />);
  fireEvent.keyDown(window, { key: "Enter" });
  expect(useLayout.getState().layout.transcriptView).toBe("raw");
});

test("empty state names the calm win condition", () => {
  useSessions.setState((state) => ({
    sessions: {
      ...state.sessions,
      s1: makeSession("s1", "running"),
      s2: makeSession("s2", "running"),
    },
  }));
  useUi.setState({ needsYouOpen: true });
  render(<NeedsYouOverlay />);
  expect(screen.getByTestId("needs-you-overlay").textContent).toContain(
    "No session needs you"
  );
});
