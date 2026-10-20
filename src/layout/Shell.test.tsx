import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";
import { useDrafts } from "../state/drafts.ts";
import { DEFAULT_LAYOUT, useLayout } from "../state/layout.ts";
import { useSessions } from "../state/sessions.ts";
import { showToast } from "../ui/Toast.tsx";
import { Shell } from "./Shell.tsx";

beforeEach(() => {
  useSessions.setState({
    activeSessionId: null,
    activity: {},
    events: {},
    projects: [],
    sessions: {},
  });
  useLayout.setState({ inspectorTab: "details", layout: DEFAULT_LAYOUT });
  useDrafts.setState({ drafts: {}, insertRequest: null });
});

/** The session the composer tests need active, so PromptBar actually mounts
 * against it instead of dropping every insert as targeting a stale session. */
function addActiveSession(): void {
  const state = useSessions.getState();
  state.addSession({
    archivedAt: null,
    baselineOid: null,
    claudeSessionId: null,
    createdAt: 1,
    cwd: "",
    id: "s1",
    projectId: "p1",
    status: "idle",
    summary: "",
    title: "s1",
    titleLocked: false,
    worktreePath: null,
  });
  state.setActiveSession("s1");
}

/** Point jsdom's window geometry at the given rect on a 2560x1415 work area. */
function setWindowRect(rect: {
  height: number;
  width: number;
  x: number;
  y: number;
}): void {
  Object.defineProperty(window, "screenX", {
    configurable: true,
    value: rect.x,
  });
  Object.defineProperty(window, "screenY", {
    configurable: true,
    value: rect.y,
  });
  Object.defineProperty(window, "outerWidth", {
    configurable: true,
    value: rect.width,
  });
  Object.defineProperty(window, "outerHeight", {
    configurable: true,
    value: rect.height,
  });
  Object.defineProperty(window.screen, "availWidth", {
    configurable: true,
    value: 2560,
  });
  Object.defineProperty(window.screen, "availHeight", {
    configurable: true,
    value: 1415,
  });
}

function renderShell() {
  return render(
    <Shell onCloseSession={vi.fn()} onNewSession={vi.fn()}>
      <div>content</div>
    </Shell>
  );
}

test("session panes stay mounted through every view switch (terminals must never remount)", () => {
  setWindowRect({ height: 820, width: 1280, x: 300, y: 200 });
  render(
    <Shell onCloseSession={vi.fn()} onNewSession={vi.fn()}>
      <div data-testid="session-host">content</div>
    </Shell>
  );

  const node = screen.getByTestId("session-host");
  // Cycle through every view: the child must remain the SAME DOM node —
  // a remount would dispose every xterm terminal living inside it.
  for (const view of [
    "focus",
    "command",
    "prompts",
    "settings",
    "studio",
  ] as const) {
    act(() => {
      useLayout.getState().setView(view);
    });
    expect(screen.getByTestId("session-host")).toBe(node);
  }
});

test("the session body is hidden, not unmounted, in non-session views", () => {
  setWindowRect({ height: 820, width: 1280, x: 300, y: 200 });
  render(
    <Shell onCloseSession={vi.fn()} onNewSession={vi.fn()}>
      <div data-testid="session-host">content</div>
    </Shell>
  );

  act(() => {
    useLayout.getState().setView("prompts");
  });
  const body = screen.getByTestId("session-body");
  expect(body.style.display).toBe("none");
  expect(screen.getByTestId("session-host")).toBeInTheDocument();

  act(() => {
    useLayout.getState().setView("studio");
  });
  expect(screen.getByTestId("session-body").style.display).not.toBe("none");
});

test("the Changes tab drops the composer entirely — it is for reading, not writing", () => {
  setWindowRect({ height: 820, width: 1280, x: 300, y: 200 });
  renderShell();
  expect(screen.getByLabelText("Message the session")).toBeInTheDocument();

  act(() => {
    useLayout.getState().setTranscriptView("changes");
  });
  // Off screen, but still mounted — it is the only consumer of the
  // Prompt-picker mailbox, so unmounting it would strand saved prompts.
  expect(screen.getByLabelText("Message the session")).not.toBeVisible();
  expect(screen.getByTestId("composer-shell")).toBeInTheDocument();
  // Not even the slim reveal strip shows.
  expect(
    screen.queryByRole("button", { name: "Show composer" })
  ).not.toBeInTheDocument();

  act(() => {
    useLayout.getState().setTranscriptView("raw");
  });
  expect(screen.getByLabelText("Message the session")).toBeVisible();
});

test("an open terminal dock sits below the composer, not between it and the view", () => {
  setWindowRect({ height: 820, width: 1280, x: 300, y: 200 });
  addActiveSession();
  renderShell();

  act(() => {
    useLayout.setState((state) => ({
      layout: { ...state.layout, terminalDockOpen: true },
    }));
  });

  const composer = screen.getByTestId("composer-shell");
  const dock = screen.getByTestId("terminal-dock-resize");
  expect(composer.compareDocumentPosition(dock)).toBe(
    Node.DOCUMENT_POSITION_FOLLOWING
  );
});

test("a maximized terminal dock hides the composer the same way, still mounted", () => {
  setWindowRect({ height: 820, width: 1280, x: 300, y: 200 });
  addActiveSession();
  renderShell();

  act(() => {
    useLayout.setState((state) => ({
      layout: {
        ...state.layout,
        terminalDockFullHeight: true,
        terminalDockOpen: true,
      },
    }));
  });

  expect(screen.getByLabelText("Message the session")).not.toBeVisible();
  expect(screen.getByTestId("composer-shell")).toBeInTheDocument();
});

test("a prompt insert from a maximized dock still lands in the draft", async () => {
  setWindowRect({ height: 820, width: 1280, x: 300, y: 200 });
  addActiveSession();
  renderShell();
  act(() => {
    useLayout.setState((state) => ({
      layout: {
        ...state.layout,
        terminalDockFullHeight: true,
        terminalDockOpen: true,
      },
    }));
  });

  act(() => {
    useDrafts.getState().requestInsert("s1", "a saved prompt");
  });

  // The second way the composer can vanish. Unmounted, this request would sit
  // in the mailbox and splice itself in whenever the dock came back down.
  await waitFor(() =>
    expect(useDrafts.getState().drafts.s1).toBe("a saved prompt")
  );
  expect(useDrafts.getState().insertRequest).toBeNull();
});

test("a draft survives a trip through the Changes tab", () => {
  setWindowRect({ height: 820, width: 1280, x: 300, y: 200 });
  addActiveSession();
  useDrafts.setState({
    drafts: { s1: "half-typed thought" },
    insertRequest: null,
  });
  renderShell();

  act(() => {
    useLayout.getState().setTranscriptView("changes");
  });
  act(() => {
    useLayout.getState().setTranscriptView("raw");
  });

  expect(screen.getByLabelText("Message the session")).toHaveTextContent(
    "half-typed thought"
  );
});

test("a prompt insert from the Changes tab lands in the draft, not the mailbox", async () => {
  setWindowRect({ height: 820, width: 1280, x: 300, y: 200 });
  addActiveSession();
  renderShell();
  act(() => {
    useLayout.getState().setTranscriptView("raw");
    useLayout.getState().setTranscriptView("changes");
  });

  act(() => {
    useDrafts.getState().requestInsert("s1", "a saved prompt");
  });

  // The view step-out is the mechanism; a consumed request is the outcome.
  // Left in the mailbox it would splice itself in on some later visit instead.
  expect(useLayout.getState().layout.transcriptView).toBe("raw");
  await waitFor(() =>
    expect(useDrafts.getState().drafts.s1).toBe("a saved prompt")
  );
  expect(useDrafts.getState().insertRequest).toBeNull();
});

test("an insert from Changes with the composer also collapsed resolves both", async () => {
  setWindowRect({ height: 820, width: 1280, x: 300, y: 200 });
  addActiveSession();
  useLayout.setState((state) => ({
    layout: { ...state.layout, composerCollapsed: true },
  }));
  renderShell();
  act(() => {
    useLayout.getState().setTranscriptView("raw");
    useLayout.getState().setTranscriptView("changes");
  });

  act(() => {
    useDrafts.getState().requestInsert("s1", "a saved prompt");
  });

  await waitFor(() =>
    expect(useDrafts.getState().drafts.s1).toBe("a saved prompt")
  );
  expect(useLayout.getState().layout.transcriptView).toBe("raw");
  expect(useLayout.getState().layout.composerCollapsed).toBe(false);
});

test("the toast host is mounted regardless of view (e.g. the Prompts tab)", () => {
  useLayout.setState((state) => ({
    layout: { ...state.layout, view: "prompts" },
  }));
  setWindowRect({ height: 820, width: 1280, x: 300, y: 200 });
  renderShell();

  act(() => {
    showToast("Inserted into the session draft");
  });

  expect(screen.getByRole("status")).toHaveTextContent(
    "Inserted into the session draft"
  );
});

test("the gear button opens the dedicated Settings view", () => {
  setWindowRect({ height: 820, width: 1280, x: 300, y: 200 });
  renderShell();

  expect(screen.queryByTestId("settings-view")).not.toBeInTheDocument();
  // The title bar's gear is gone with the title bar (ADR-0023); the sidebar
  // footer's is now the only one, and the one ⌘, mirrors.
  fireEvent.click(screen.getByTestId("open-settings"));

  expect(useLayout.getState().layout.view).toBe("settings");
  expect(screen.getByTestId("settings-view")).toBeInTheDocument();
});

/**
 * The sidebar carries navigation now (ADR-0023), which changes its contract:
 * it used to live inside `SessionBody` and vanish with it, and it now has to
 * outlive the view — otherwise the way back out of Settings is a keyboard
 * shortcut the user has to already know.
 */
test("the sidebar persists across every non-focus view, because nav lives in it", () => {
  setWindowRect({ height: 820, width: 1280, x: 300, y: 200 });
  renderShell();

  for (const view of ["command", "prompts", "settings", "studio"] as const) {
    act(() => {
      useLayout.getState().setView(view);
    });
    expect(screen.getByTestId("sidebar")).toBeInTheDocument();
  }

  // Focus is the one view that replaces it — that is what Focus *is*.
  act(() => {
    useLayout.getState().setView("focus");
  });
  expect(screen.queryByTestId("sidebar")).not.toBeInTheDocument();
  expect(screen.getByTestId("focus-rail")).toBeInTheDocument();
});

/**
 * The wordmark lives in the traffic-light strip, not in a block of its own.
 * That strip has to reserve 96px for the native lights whatever it holds, so
 * the brand is the one thing that costs nothing there — and the sidebar gets
 * a whole row back.
 */
test("the wordmark sits in the traffic-light strip, costing no extra row", () => {
  setWindowRect({ height: 820, width: 1280, x: 300, y: 200 });
  renderShell();

  const strip = screen.getByTestId("sidebar-top-strip");
  expect(strip).toHaveTextContent("Kriyon");
  expect(strip.style.height).toBe("46px");
  // The clearance is what makes room for it; losing that puts the wordmark
  // under the close button.
  expect(strip.style.paddingLeft).toBe("96px");
});

test("the sidebar nav rows switch views, and name themselves the way they read", () => {
  setWindowRect({ height: 820, width: 1280, x: 300, y: 200 });
  renderShell();

  // Visible label and accessible name are the same string on purpose: a
  // control called "Studio" that reads "Sessions" is worse than either.
  fireEvent.click(screen.getByRole("button", { name: "Command center" }));
  expect(useLayout.getState().layout.view).toBe("command");

  fireEvent.click(screen.getByRole("button", { name: "Prompts" }));
  expect(useLayout.getState().layout.view).toBe("prompts");

  fireEvent.click(screen.getByRole("button", { name: "Sessions" }));
  expect(useLayout.getState().layout.view).toBe("studio");
});

/**
 * The sidebar outlives the view now, which means every session it lists is
 * clickable from Settings, Prompts and the Command centre — views that used
 * to replace the sidebar entirely. Selecting one has to bring the session
 * view back, or the click looks like it did nothing at all.
 */
test("picking a session from a full view returns to the session view", () => {
  setWindowRect({ height: 820, width: 1280, x: 300, y: 200 });
  addActiveSession();
  useSessions.getState().addSession({
    archivedAt: null,
    baselineOid: null,
    claudeSessionId: null,
    createdAt: 2,
    cwd: "",
    id: "s2",
    projectId: "p1",
    status: "idle",
    summary: "",
    title: "Second session",
    titleLocked: false,
    worktreePath: null,
  });
  useSessions.setState({
    projects: [
      {
        color: null,
        id: "p1",
        name: "kriyon",
        path: "/tmp/kriyon",
        setupCommand: null,
      },
    ],
  });
  renderShell();

  act(() => {
    useLayout.getState().setView("settings");
  });
  fireEvent.click(screen.getByRole("button", { name: "Open Second session" }));

  expect(useLayout.getState().layout.view).toBe("studio");
  expect(useSessions.getState().activeSessionId).toBe("s2");
});

test("picking a session from Focus stays in Focus — it shows sessions too", () => {
  setWindowRect({ height: 820, width: 1280, x: 300, y: 200 });
  addActiveSession();
  renderShell();

  act(() => {
    useLayout.getState().setView("focus");
  });
  act(() => {
    useLayout.getState().revealSessionView();
  });

  expect(useLayout.getState().layout.view).toBe("focus");
});

test("the active nav row says so to assistive tech, not only in colour", () => {
  setWindowRect({ height: 820, width: 1280, x: 300, y: 200 });
  renderShell();

  expect(screen.getByRole("button", { name: "Sessions" })).toHaveAttribute(
    "aria-current",
    "page"
  );
  act(() => {
    useLayout.getState().setView("prompts");
  });
  expect(screen.getByRole("button", { name: "Sessions" })).not.toHaveAttribute(
    "aria-current"
  );
  expect(screen.getByRole("button", { name: "Prompts" })).toHaveAttribute(
    "aria-current",
    "page"
  );
});

test("Focus is an escape hatch in the sidebar, and the focus rail is the way back", () => {
  setWindowRect({ height: 820, width: 1280, x: 300, y: 200 });
  renderShell();

  fireEvent.click(screen.getByLabelText("Focus mode"));
  expect(useLayout.getState().layout.view).toBe("focus");

  // With the sidebar gone, the rail has to offer the way out — otherwise
  // Focus is a one-way door once the view switcher is no longer global.
  fireEvent.click(
    within(screen.getByTestId("focus-rail")).getByLabelText("Sessions")
  );
  expect(useLayout.getState().layout.view).toBe("studio");
});

/**
 * There is no single title bar to drag the window by any more. Each column's
 * top 46px is a drag region, and a view whose header forgets it is a view the
 * user cannot move the window from.
 */
test("every top-band header is a window drag region", () => {
  setWindowRect({ height: 820, width: 1280, x: 300, y: 200 });
  renderShell();

  expect(screen.getByTestId("sidebar-top-strip")).toHaveAttribute(
    "data-tauri-drag-region"
  );

  for (const [view, testId] of [
    ["command", "command-center-header"],
    ["prompts", "prompts-header"],
    ["settings", "settings-header"],
  ] as const) {
    act(() => {
      useLayout.getState().setView(view);
    });
    expect(screen.getByTestId(testId)).toHaveAttribute(
      "data-tauri-drag-region"
    );
  }
});

/**
 * The 96px traffic-light clearance used to be the title bar's left padding.
 * It is now the sidebar's top strip — so when the sidebar slides away, the
 * clearance has to move with it or the lights land on the breadcrumb.
 */
test("collapsing the sidebar moves the traffic-light clearance to the main header", () => {
  setWindowRect({ height: 820, width: 1280, x: 300, y: 200 });
  addActiveSession();
  renderShell();

  const band = screen.getByTestId("main-top-band");
  expect(band.style.paddingLeft).toBe("");

  act(() => {
    useLayout.getState().toggleSidebarCollapsed();
  });
  expect(screen.getByTestId("main-top-band").style.paddingLeft).toBe("96px");
});

test("⌘, opens the Settings view from any other view", () => {
  useLayout.setState((state) => ({
    layout: { ...state.layout, view: "studio" },
  }));
  setWindowRect({ height: 820, width: 1280, x: 300, y: 200 });
  renderShell();

  fireEvent.keyDown(window, { key: ",", metaKey: true });

  expect(useLayout.getState().layout.view).toBe("settings");
});

test("the shell fills the native window edge-to-edge (macOS owns the frame)", () => {
  setWindowRect({ height: 820, width: 1280, x: 300, y: 200 });
  renderShell();

  // No CSS-faked frame: the shell fills the viewport and leaves rounded
  // corners, shadow, and the traffic lights to the native window.
  const shell = screen.getByTestId("app-shell");
  expect(shell.style.width).toBe("100vw");
  expect(shell.style.height).toBe("100vh");
  expect(shell.style.borderRadius).toBe("");
  expect(shell.style.boxShadow).toBe("");
  expect(screen.queryByLabelText("Close window")).not.toBeInTheDocument();
});

test("the sidebar toggle slides the sidebar away in the studio view", () => {
  setWindowRect({ height: 820, width: 1280, x: 300, y: 200 });
  renderShell();

  expect(screen.getByTestId("sidebar")).toBeInTheDocument();
  fireEvent.click(screen.getByLabelText("Collapse sidebar"));

  // The panel slides closed: content stays mounted for the slide, the wrapper
  // is already bound for width 0, and the content unmounts when it settles.
  const panel = screen.getByTestId("sidebar-panel");
  expect(panel.style.flexBasis).toBe("0px");
  expect(screen.getByTestId("sidebar")).toBeInTheDocument();
  fireEvent.transitionEnd(panel);
  expect(screen.queryByTestId("sidebar")).not.toBeInTheDocument();

  fireEvent.click(screen.getByLabelText("Expand sidebar"));
  expect(screen.getByTestId("sidebar")).toBeInTheDocument();
});

test("the inspector widens while its Activity tab is open", () => {
  setWindowRect({ height: 820, width: 1280, x: 300, y: 200 });
  renderShell();
  const panel = screen.getByTestId("inspector-panel");
  expect(panel.style.width).toBe("280px");
  act(() => useLayout.getState().setInspectorTab("activity"));
  expect(panel.style.width).toBe("380px");
  act(() => useLayout.getState().setInspectorTab("details"));
  expect(panel.style.width).toBe("280px");
});

test("the inspector collapses to the icon rail and expands from it", () => {
  setWindowRect({ height: 820, width: 1280, x: 300, y: 200 });
  renderShell();

  expect(screen.getByTestId("inspector")).toBeInTheDocument();
  fireEvent.click(screen.getByLabelText("Collapse inspector"));

  // The inspector stays mounted while the panel slides down to rail width;
  // the rail takes over once the slide settles.
  expect(screen.getByTestId("inspector")).toBeInTheDocument();
  fireEvent.transitionEnd(screen.getByTestId("inspector-panel"));
  expect(screen.queryByTestId("inspector")).not.toBeInTheDocument();
  expect(screen.getByTestId("inspector-rail")).toBeInTheDocument();

  // The rail's button is now the only "Expand inspector" — the title bar's
  // twin went with the title bar.
  fireEvent.click(
    within(screen.getByTestId("inspector-rail")).getByLabelText(
      "Expand inspector"
    )
  );
  expect(screen.getByTestId("inspector")).toBeInTheDocument();
  expect(screen.queryByTestId("inspector-rail")).not.toBeInTheDocument();
});
