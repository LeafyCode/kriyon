import { beforeEach, expect, test } from "vitest";
import { DEFAULT_LAYOUT, effectiveSessionSort, useLayout } from "./layout.ts";

beforeEach(() => {
  useLayout.setState({ layout: DEFAULT_LAYOUT });
});

test("toggleView flips between studio and focus", () => {
  const { toggleView } = useLayout.getState();
  expect(useLayout.getState().layout.view).toBe("studio");
  toggleView();
  expect(useLayout.getState().layout.view).toBe("focus");
  toggleView();
  expect(useLayout.getState().layout.view).toBe("studio");
});

test("setNotifyPreference updates the persisted preference", () => {
  const { setNotifyPreference } = useLayout.getState();
  setNotifyPreference("only_blocked");
  expect(useLayout.getState().layout.notifyPreference).toBe("only_blocked");
  setNotifyPreference("none");
  expect(useLayout.getState().layout.notifyPreference).toBe("none");
});

test("setView can switch to the command view", () => {
  const { setView } = useLayout.getState();
  setView("command");
  expect(useLayout.getState().layout.view).toBe("command");
});

test("setView routes and stores the prompts view", () => {
  useLayout.getState().setView("prompts");
  expect(useLayout.getState().layout.view).toBe("prompts");
});

test("toggleTranscriptView flips raw <-> changes (matching SessionHeader's tabs)", () => {
  const { toggleTranscriptView } = useLayout.getState();
  expect(useLayout.getState().layout.transcriptView).toBe("raw");
  toggleTranscriptView();
  expect(useLayout.getState().layout.transcriptView).toBe("changes");
  toggleTranscriptView();
  expect(useLayout.getState().layout.transcriptView).toBe("raw");
});

test("setTranscriptView accepts the changes view", () => {
  useLayout.getState().setTranscriptView("changes");
  expect(useLayout.getState().layout.transcriptView).toBe("changes");
  useLayout.getState().setTranscriptView("raw");
  expect(useLayout.getState().layout.transcriptView).toBe("raw");
});

test("toggleProjectCollapsed collapses then re-expands a project", () => {
  const s = useLayout.getState();

  s.toggleProjectCollapsed("p1");
  expect(useLayout.getState().layout.collapsedProjectIds).toEqual(["p1"]);

  useLayout.getState().toggleProjectCollapsed("p1");
  expect(useLayout.getState().layout.collapsedProjectIds).toEqual([]);
});

test("setSidebarWidth clamps to the resizable range", () => {
  useLayout.getState().setSidebarWidth(320);
  expect(useLayout.getState().layout.sidebarWidth).toBe(320);

  useLayout.getState().setSidebarWidth(50);
  expect(useLayout.getState().layout.sidebarWidth).toBe(220);

  useLayout.getState().setSidebarWidth(900);
  expect(useLayout.getState().layout.sidebarWidth).toBe(420);
});

test("the default layout starts on the default theme", () => {
  expect(DEFAULT_LAYOUT.themeId).toBe("steel");
});

test("setThemeId switches the active theme id", () => {
  useLayout.getState().setThemeId("teal");
  expect(useLayout.getState().layout.themeId).toBe("teal");
});

test("the composer starts visible and toggles hidden", () => {
  expect(useLayout.getState().layout.composerCollapsed).toBe(false);

  useLayout.getState().toggleComposerCollapsed();
  expect(useLayout.getState().layout.composerCollapsed).toBe(true);

  useLayout.getState().toggleComposerCollapsed();
  expect(useLayout.getState().layout.composerCollapsed).toBe(false);
});

test("sidebar and inspector start expanded and toggle independently", () => {
  const { toggleSidebarCollapsed, toggleInspectorCollapsed } =
    useLayout.getState();
  expect(useLayout.getState().layout.sidebarCollapsed).toBe(false);
  expect(useLayout.getState().layout.inspectorCollapsed).toBe(false);

  toggleSidebarCollapsed();
  expect(useLayout.getState().layout.sidebarCollapsed).toBe(true);
  expect(useLayout.getState().layout.inspectorCollapsed).toBe(false);

  toggleInspectorCollapsed();
  toggleSidebarCollapsed();
  expect(useLayout.getState().layout.sidebarCollapsed).toBe(false);
  expect(useLayout.getState().layout.inspectorCollapsed).toBe(true);
});

test("toggleTerminalDock flips the dock open flag", () => {
  expect(useLayout.getState().layout.terminalDockOpen).toBe(false);
  useLayout.getState().toggleTerminalDock();
  expect(useLayout.getState().layout.terminalDockOpen).toBe(true);
});

test("setTerminalDockHeight clamps within [120, 640]", () => {
  useLayout.getState().setTerminalDockHeight(40);
  expect(useLayout.getState().layout.terminalDockHeight).toBe(120);
  useLayout.getState().setTerminalDockHeight(9000);
  expect(useLayout.getState().layout.terminalDockHeight).toBe(640);
});

test("toggleTerminalDockFullHeight flips the full-height flag", () => {
  expect(useLayout.getState().layout.terminalDockFullHeight).toBe(false);
  useLayout.getState().toggleTerminalDockFullHeight();
  expect(useLayout.getState().layout.terminalDockFullHeight).toBe(true);
});

test("inspectorChangesOpen starts open and toggles via setInspectorChangesOpen", () => {
  expect(useLayout.getState().layout.inspectorChangesOpen).toBe(true);

  useLayout.getState().setInspectorChangesOpen(false);
  expect(useLayout.getState().layout.inspectorChangesOpen).toBe(false);

  useLayout.getState().setInspectorChangesOpen(true);
  expect(useLayout.getState().layout.inspectorChangesOpen).toBe(true);
});

test("menuBarMode defaults to grouped", () => {
  expect(DEFAULT_LAYOUT.menuBarMode).toBe("grouped");
});

test("setMenuBarMode switches the mode", () => {
  useLayout.getState().setMenuBarMode("compact");
  expect(useLayout.getState().layout.menuBarMode).toBe("compact");
  useLayout.getState().setMenuBarMode("grouped");
  expect(useLayout.getState().layout.menuBarMode).toBe("grouped");
});

test("setSessionSort sets the global mode and clears every project override", () => {
  const s = useLayout.getState();
  s.setProjectSort("p1", "name");
  s.setProjectSort("p2", "manual");
  useLayout.getState().setSessionSort("name");
  expect(useLayout.getState().layout.sessionSort).toBe("name");
  expect(useLayout.getState().layout.projectSortOverrides).toEqual({});
});

test("setSessionSort keeps remembered manual orders", () => {
  useLayout.getState().setManualSessionOrder("p1", ["b", "a"]);
  useLayout.getState().setSessionSort("date");
  expect(useLayout.getState().layout.manualSessionOrder).toEqual({
    p1: ["b", "a"],
  });
});

test("setProjectSort sets and clears one project's override", () => {
  useLayout.getState().setProjectSort("p1", "manual");
  expect(useLayout.getState().layout.projectSortOverrides).toEqual({
    p1: "manual",
  });
  useLayout.getState().setProjectSort("p1", null);
  expect(useLayout.getState().layout.projectSortOverrides).toEqual({});
});

test("setManualSessionOrder writes the order and pins the project to manual", () => {
  useLayout.getState().setManualSessionOrder("p1", ["c", "a", "b"]);
  const { layout } = useLayout.getState();
  expect(layout.manualSessionOrder.p1).toEqual(["c", "a", "b"]);
  expect(layout.projectSortOverrides.p1).toBe("manual");
});

test("setManualSessionOrder never pins when the project is already manual", () => {
  useLayout.getState().setSessionSort("manual");
  useLayout.getState().setManualSessionOrder("p1", ["a", "b"]);
  // Global is manual, so no override needed — a later global change resets
  // overrides and this project should follow it again.
  expect(useLayout.getState().layout.projectSortOverrides).toEqual({});
});

test("manualProjectOrder starts empty and setManualProjectOrder writes it", () => {
  expect(useLayout.getState().layout.manualProjectOrder).toEqual([]);
  useLayout.getState().setManualProjectOrder(["p2", "p1", "p3"]);
  expect(useLayout.getState().layout.manualProjectOrder).toEqual([
    "p2",
    "p1",
    "p3",
  ]);
});

test("effectiveSessionSort prefers the project override", () => {
  useLayout.getState().setSessionSort("name");
  useLayout.getState().setProjectSort("p1", "manual");
  const { layout } = useLayout.getState();
  expect(effectiveSessionSort(layout, "p1")).toBe("manual");
  expect(effectiveSessionSort(layout, "p2")).toBe("name");
});

test("hideOlderThan defaults to off and setHideOlderThan updates it", () => {
  expect(useLayout.getState().layout.hideOlderThan).toBe("off");
  useLayout.getState().setHideOlderThan("1d");
  expect(useLayout.getState().layout.hideOlderThan).toBe("1d");
});

test("leaveChangesView returns to the terminal", () => {
  const s = useLayout.getState();
  s.setTranscriptView("changes");
  s.leaveChangesView();
  expect(useLayout.getState().layout.transcriptView).toBe("raw");
});

test("leaveChangesView is a no-op when not in changes", () => {
  useLayout.getState().setTranscriptView("raw");
  useLayout.getState().leaveChangesView();
  expect(useLayout.getState().layout.transcriptView).toBe("raw");
});

test("showSessionView returns to the session view from a full view", () => {
  const s = useLayout.getState();
  s.setView("command");
  s.showSessionView();
  expect(useLayout.getState().layout.view).toBe("studio");
});

test("showSessionView stays in Focus, which already shows sessions", () => {
  const s = useLayout.getState();
  s.setView("focus");
  s.showSessionView();
  expect(useLayout.getState().layout.view).toBe("focus");
});

test("showSessionView leaves the current tab alone", () => {
  const s = useLayout.getState();
  s.setView("prompts");
  s.setTranscriptView("changes");
  s.showSessionView();
  expect(useLayout.getState().layout.transcriptView).toBe("changes");
});

test("revealSessionView shows the session view and lands on the terminal", () => {
  const s = useLayout.getState();
  s.setView("prompts");
  s.setTranscriptView("changes");
  s.revealSessionView();
  expect(useLayout.getState().layout.view).toBe("studio");
  expect(useLayout.getState().layout.transcriptView).toBe("raw");
});

test("revealSessionView stays in Focus", () => {
  const s = useLayout.getState();
  s.setView("focus");
  s.revealSessionView();
  expect(useLayout.getState().layout.view).toBe("focus");
});

test("the session view the user last chose is the one sessions come back to", () => {
  useLayout.setState({ layout: DEFAULT_LAYOUT });
  const store = useLayout.getState();
  store.setTranscriptView("structured");
  expect(useLayout.getState().layout.preferredSessionView).toBe("structured");
  store.setTranscriptView("changes");
  store.leaveChangesView();
  expect(useLayout.getState().layout.transcriptView).toBe("structured");
  store.setTranscriptView("changes");
  store.revealSessionView();
  expect(useLayout.getState().layout.transcriptView).toBe("structured");
  store.toggleTranscriptView();
  store.toggleTranscriptView();
  expect(useLayout.getState().layout.transcriptView).toBe("structured");
  // Changes is a place you visit, not a view sessions open in.
  expect(useLayout.getState().layout.preferredSessionView).toBe("structured");
  store.setTranscriptView("raw");
  expect(useLayout.getState().layout.preferredSessionView).toBe("raw");
});
