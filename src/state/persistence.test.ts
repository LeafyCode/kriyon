import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  listProjects,
  listPrompts,
  listSessions,
  loadLayout,
  saveLayout,
  upsertProject,
  upsertSession,
} from "../ipc/bridge.ts";
import type { ProjectRow, SavedPrompt, SessionRow } from "../types.ts";
import { DEFAULT_LAYOUT, useLayout } from "./layout.ts";
import {
  hydrate,
  installPersistence,
  parseLayout as parseLayoutForTest,
  persistKey as persistKeyForTest,
  pruneSortState,
} from "./persistence.ts";
import { usePromptLibrary } from "./promptLibrary.ts";
import { sessionRow, type UiSession, useSessions } from "./sessions.ts";
import { useTerminals } from "./terminals.ts";

vi.mock("../ipc/bridge", () => ({
  listPrompts: vi.fn(),
  listProjects: vi.fn(),
  listSessions: vi.fn(),
  loadLayout: vi.fn(),
  saveLayout: vi.fn(),
  upsertProject: vi.fn(),
  upsertSession: vi.fn(),
}));

const mockedListPrompts = vi.mocked(listPrompts);
const mockedListProjects = vi.mocked(listProjects);
const mockedListSessions = vi.mocked(listSessions);
const mockedLoadLayout = vi.mocked(loadLayout);
const mockedUpsertSession = vi.mocked(upsertSession);
const mockedUpsertProject = vi.mocked(upsertProject);

function samplePrompt(): SavedPrompt {
  return {
    body: "body",
    createdMs: 1,
    favourite: false,
    id: "pr1",
    lastUsedMs: null,
    tags: [],
    title: "title",
    updatedMs: 1,
    useCount: 0,
  };
}

/** Active persistence subscriptions, torn down after each test for isolation. */
const installed: Array<() => void> = [];
function install(): () => void {
  const stop = installPersistence();
  installed.push(stop);
  return stop;
}

afterEach(() => {
  while (installed.length > 0) {
    installed.pop()?.();
  }
});

function project(id: string): ProjectRow {
  return { color: null, id, name: id, path: `/${id}`, setupCommand: null };
}

function session(
  id: string,
  projectId: string,
  baselineOid: string | null = null
): UiSession {
  return {
    archivedAt: null,
    baselineOid,
    claudeSessionId: null,
    createdAt: 1,
    cwd: `/${projectId}`,
    id,
    projectId,
    status: "idle",
    summary: "",
    title: id,
    titleLocked: false,
    worktreePath: null,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // Persistence IPC is fire-and-forget; resolve so `ignore(...)` has a promise.
  mockedUpsertSession.mockResolvedValue(undefined);
  mockedUpsertProject.mockResolvedValue(undefined);
  vi.mocked(saveLayout).mockResolvedValue(undefined);
  vi.mocked(loadLayout).mockResolvedValue(null);
  mockedListPrompts.mockResolvedValue([]);
  usePromptLibrary.setState({ prompts: [] });
  useSessions.setState({
    activeSessionId: null,
    activity: {},
    events: {},
    projects: [],
    sessions: {},
    usage: {},
  });
  useLayout.setState({ layout: DEFAULT_LAYOUT });
});

test("hydrate populates the store from the bridge", async () => {
  mockedListProjects.mockResolvedValue([
    { color: null, id: "p1", name: "Proj", path: "/p", setupCommand: null },
  ]);
  mockedListSessions.mockResolvedValue([
    {
      archivedAt: null,
      baselineOid: null,
      claudeSessionId: null,
      createdAt: 5,
      cwd: "/p",
      id: "s1",
      projectId: "p1",
      title: "Sess",
      titleLocked: false,
      worktreePath: null,
    },
  ]);
  mockedLoadLayout.mockResolvedValue(
    JSON.stringify({ collapsedProjectIds: ["p1"], view: "focus" })
  );
  mockedListPrompts.mockResolvedValue([samplePrompt()]);

  await hydrate();

  const state = useSessions.getState();
  expect(state.projects).toHaveLength(1);
  expect(state.sessions.s1?.status).toBe("idle");
  expect(useLayout.getState().layout.view).toBe("focus");
  expect(state.activeSessionId).toBe("s1");
  expect(usePromptLibrary.getState().prompts).toContainEqual(samplePrompt());
});

test("hydrate round-trips a persisted notifyPreference and command view", async () => {
  mockedListProjects.mockResolvedValue([]);
  mockedListSessions.mockResolvedValue([]);
  mockedLoadLayout.mockResolvedValue(
    JSON.stringify({
      collapsedProjectIds: [],
      sidebarWidth: 278,
      notifyPreference: "only_blocked",
      view: "command",
    })
  );

  await hydrate();

  const { layout } = useLayout.getState();
  expect(layout.view).toBe("command");
  expect(layout.notifyPreference).toBe("only_blocked");
});

test("hydrate round-trips the sidebar mode and defaults it to calm", async () => {
  mockedListProjects.mockResolvedValue([]);
  mockedListSessions.mockResolvedValue([]);
  mockedLoadLayout.mockResolvedValue(JSON.stringify({ sidebarMode: "triage" }));

  await hydrate();
  expect(useLayout.getState().layout.sidebarMode).toBe("triage");

  useLayout.setState({ layout: DEFAULT_LAYOUT });
  mockedLoadLayout.mockResolvedValue(JSON.stringify({ sidebarMode: "bogus" }));
  await hydrate();
  expect(useLayout.getState().layout.sidebarMode).toBe("calm");
});

test("hydrate round-trips a persisted settings view", async () => {
  mockedListProjects.mockResolvedValue([]);
  mockedListSessions.mockResolvedValue([]);
  mockedLoadLayout.mockResolvedValue(JSON.stringify({ view: "settings" }));

  await hydrate();
  expect(useLayout.getState().layout.view).toBe("settings");
});

test("hydrate round-trips a persisted prompts view", async () => {
  mockedListProjects.mockResolvedValue([]);
  mockedListSessions.mockResolvedValue([]);
  mockedLoadLayout.mockResolvedValue(
    JSON.stringify({ sidebarWidth: 301, view: "prompts" })
  );

  await hydrate();

  const { layout } = useLayout.getState();
  expect(layout.view).toBe("prompts");
  expect(layout.sidebarWidth).toBe(301);
});

test("hydrate keeps other layout fields when only the view is unknown", async () => {
  mockedListProjects.mockResolvedValue([]);
  mockedListSessions.mockResolvedValue([]);
  mockedLoadLayout.mockResolvedValue(
    JSON.stringify({
      collapsedProjectIds: ["p1"],
      notifyPreference: "only_blocked",
      sidebarWidth: 333,
      view: "bogus-view",
    })
  );

  await hydrate();

  const { layout } = useLayout.getState();
  // An unrecognized view must not discard the rest of the persisted layout.
  expect(layout.view).toBe("studio");
  expect(layout.sidebarWidth).toBe(333);
  expect(layout.notifyPreference).toBe("only_blocked");
  expect(layout.collapsedProjectIds).toEqual(["p1"]);
});

test("hydrate defaults notifyPreference to all when missing or invalid", async () => {
  mockedListProjects.mockResolvedValue([]);
  mockedListSessions.mockResolvedValue([]);
  mockedLoadLayout.mockResolvedValue(
    JSON.stringify({ view: "studio", notifyPreference: "bogus" })
  );

  await hydrate();

  expect(useLayout.getState().layout.notifyPreference).toBe("all");
});

test("hydrate keeps the default layout when JSON is malformed", async () => {
  mockedListProjects.mockResolvedValue([]);
  mockedListSessions.mockResolvedValue([]);
  mockedLoadLayout.mockResolvedValue("{not valid json");

  await hydrate();

  expect(useLayout.getState().layout.view).toBe("studio");
});

test("installPersistence ignores high-frequency event/usage/activity churn", () => {
  vi.useFakeTimers();
  const state = useSessions.getState();
  state.addProject(project("p1"));
  state.addSession(session("s1", "p1"));
  const stop = install();
  // Forget the (none expected) initial work and isolate the churn below.
  vi.clearAllMocks();

  state.appendEvent("s1", { id: "e1", kind: "assistant", text: "hi" });
  state.applyUsage("s1", {
    contextWindowSize: null,
    inputTokens: 10,
    model: null,
    outputTokens: 5,
    sessionId: null,
    usedPercentage: null,
  });
  state.applyActivity("s1", {
    main: { currentTool: null },
    pendingAsk: null,
    shells: [],
    subagents: [],
    tasks: [],
  });
  vi.runAllTimers();

  expect(mockedUpsertSession).not.toHaveBeenCalled();
  expect(mockedUpsertProject).not.toHaveBeenCalled();

  stop();
  vi.useRealTimers();
});

test("installPersistence ignores status-only changes (status is not persisted)", () => {
  vi.useFakeTimers();
  const state = useSessions.getState();
  state.addProject(project("p1"));
  state.addSession(session("s1", "p1"));
  const stop = install();
  vi.clearAllMocks();

  state.applyStatus("s1", "running", "$ cargo build");
  vi.runAllTimers();

  expect(mockedUpsertSession).not.toHaveBeenCalled();

  stop();
  vi.useRealTimers();
});

test("installPersistence persists when a session is added", () => {
  vi.useFakeTimers();
  const state = useSessions.getState();
  state.addProject(project("p1"));
  const stop = install();
  vi.clearAllMocks();

  state.addSession(session("s1", "p1"));
  vi.runAllTimers();

  expect(mockedUpsertSession).toHaveBeenCalledTimes(1);

  stop();
  vi.useRealTimers();
});

test("installPersistence persists when a persisted field (title) changes", () => {
  vi.useFakeTimers();
  const state = useSessions.getState();
  state.addProject(project("p1"));
  state.addSession(session("s1", "p1"));
  const stop = install();
  vi.clearAllMocks();

  state.applyTitle("s1", "Renamed");
  vi.runAllTimers();

  expect(mockedUpsertSession).toHaveBeenCalled();

  stop();
  vi.useRealTimers();
});

test("persist preserves a non-null baselineOid instead of clobbering it with null", () => {
  vi.useFakeTimers();
  const state = useSessions.getState();
  state.addProject(project("p1"));
  state.addSession(session("s1", "p1", "abc123"));
  const stop = install();
  vi.clearAllMocks();

  // Any unrelated persisted-field change triggers the debounced sweep over
  // every session — this must not zero out a session's captured baseline.
  state.applyTitle("s1", "Renamed");
  vi.runAllTimers();

  expect(mockedUpsertSession).toHaveBeenCalledWith(
    expect.objectContaining({ baselineOid: "abc123" })
  );

  stop();
  vi.useRealTimers();
});

test("installPersistence persists when only baselineOid changes", () => {
  vi.useFakeTimers();
  const state = useSessions.getState();
  state.addProject(project("p1"));
  state.addSession(session("s1", "p1"));
  const stop = install();
  vi.clearAllMocks();

  // No setter exists yet for baselineOid (a later task adds capture), so the
  // fingerprint is exercised directly against the sessions map.
  useSessions.setState((s) => ({
    sessions: {
      ...s.sessions,
      s1: { ...s.sessions.s1, baselineOid: "deadbeef" } as UiSession,
    },
  }));
  vi.runAllTimers();

  expect(mockedUpsertSession).toHaveBeenCalledWith(
    expect.objectContaining({ baselineOid: "deadbeef" })
  );

  stop();
  vi.useRealTimers();
});

/** Change `value` to something distinct of the same primitive shape, so a
 * perturbed `SessionRow` field is guaranteed to differ from the original —
 * whatever its type. */
function perturbField(
  value: string | number | boolean | null | undefined
): string | number | boolean | null {
  if (typeof value === "boolean") {
    return !value;
  }
  if (typeof value === "number") {
    return value + 1;
  }
  if (typeof value === "string") {
    return `${value}-x`;
  }
  return "sentinel";
}

test("persistKey changes when any single SessionRow field is perturbed", () => {
  const base: UiSession = {
    archivedAt: 1000,
    baselineOid: "base-oid",
    claudeSessionId: "claude-1",
    createdAt: 500,
    cwd: "/repo",
    id: "s1",
    projectId: "p1",
    status: "idle",
    summary: "",
    title: "Title",
    titleLocked: true,
    worktreePath: "/repo/wt",
  };
  useSessions.setState({ projects: [], sessions: { s1: base } });
  const baseKey = persistKeyForTest(useSessions.getState());

  const row = sessionRow(base);
  for (const key of Object.keys(row) as (keyof SessionRow)[]) {
    const perturbedRow = {
      ...row,
      [key]: perturbField(row[key]),
    } as SessionRow;
    useSessions.setState({
      projects: [],
      sessions: { s1: { ...base, ...perturbedRow } },
    });
    const perturbedKey = persistKeyForTest(useSessions.getState());
    expect(
      perturbedKey,
      `persistKey should change when ${key} changes`
    ).not.toBe(baseKey);
  }
});

test("hydrate restores a persisted sidebar width, defaulting when absent", async () => {
  mockedListProjects.mockResolvedValue([]);
  mockedListSessions.mockResolvedValue([]);
  mockedLoadLayout.mockResolvedValue(
    JSON.stringify({ sidebarWidth: 340, view: "studio" })
  );

  await hydrate();
  expect(useLayout.getState().layout.sidebarWidth).toBe(340);

  mockedLoadLayout.mockResolvedValue(JSON.stringify({ view: "studio" }));
  await hydrate();
  expect(useLayout.getState().layout.sidebarWidth).toBe(278);
});

test("hydrate does not block core hydration when listPrompts rejects", async () => {
  mockedListProjects.mockResolvedValue([
    { color: null, id: "p1", name: "Proj", path: "/p", setupCommand: null },
  ]);
  mockedListSessions.mockResolvedValue([
    {
      archivedAt: null,
      baselineOid: null,
      claudeSessionId: null,
      createdAt: 5,
      cwd: "/p",
      id: "s1",
      projectId: "p1",
      title: "Sess",
      titleLocked: false,
      worktreePath: null,
    },
  ]);
  mockedLoadLayout.mockResolvedValue(
    JSON.stringify({ collapsedProjectIds: ["p1"], view: "focus" })
  );
  mockedListPrompts.mockRejectedValue(new Error("Prompts load failed"));

  await hydrate();

  // Core hydration succeeds despite prompt library rejection.
  const state = useSessions.getState();
  expect(state.projects).toHaveLength(1);
  expect(state.sessions.s1?.status).toBe("idle");
  expect(useLayout.getState().layout.view).toBe("focus");
  expect(state.activeSessionId).toBe("s1");
  // Prompt library degrades to empty on failure.
  expect(usePromptLibrary.getState().prompts).toEqual([]);
});

test("hydrate round-trips a persisted theme and drops an unknown one", async () => {
  mockedListProjects.mockResolvedValue([]);
  mockedListSessions.mockResolvedValue([]);
  mockedLoadLayout.mockResolvedValue(
    JSON.stringify({ sidebarWidth: 301, themeId: "graphite" })
  );

  await hydrate();
  expect(useLayout.getState().layout.themeId).toBe("graphite");

  mockedLoadLayout.mockResolvedValue(
    JSON.stringify({ sidebarWidth: 301, themeId: "hotdog-stand" })
  );

  await hydrate();
  // An unknown theme id falls back to the default without touching the rest.
  expect(useLayout.getState().layout.themeId).toBe("steel");
  expect(useLayout.getState().layout.sidebarWidth).toBe(301);
});

test("hydrate round-trips the collapsed panel flags", async () => {
  mockedListProjects.mockResolvedValue([]);
  mockedListSessions.mockResolvedValue([]);
  mockedLoadLayout.mockResolvedValue(
    JSON.stringify({ inspectorCollapsed: true, sidebarCollapsed: "bogus" })
  );

  await hydrate();

  const { layout } = useLayout.getState();
  expect(layout.inspectorCollapsed).toBe(true);
  // A non-boolean value degrades to expanded rather than poisoning the state.
  expect(layout.sidebarCollapsed).toBe(false);
});

test("hydrate round-trips the composer flag and defaults it to visible", async () => {
  mockedListProjects.mockResolvedValue([]);
  mockedListSessions.mockResolvedValue([]);
  mockedLoadLayout.mockResolvedValue(
    JSON.stringify({ composerCollapsed: true })
  );

  await hydrate();
  expect(useLayout.getState().layout.composerCollapsed).toBe(true);

  // A layout persisted before the flag existed degrades to visible.
  mockedLoadLayout.mockResolvedValue(JSON.stringify({ view: "studio" }));
  await hydrate();
  expect(useLayout.getState().layout.composerCollapsed).toBe(false);
});

test("inspectorChangesOpen survives a save/load round-trip", () => {
  useLayout.getState().setInspectorChangesOpen(false);
  const restored = parseLayoutForTest(
    JSON.stringify(useLayout.getState().layout)
  );
  expect(restored?.inspectorChangesOpen).toBe(false);
});

test("inspectorChangesOpen defaults to open when missing or garbage", () => {
  // A layout persisted before the field existed degrades to open.
  expect(
    parseLayoutForTest(JSON.stringify({ view: "studio" }))?.inspectorChangesOpen
  ).toBe(true);
  // A non-boolean value degrades to open rather than poisoning the state.
  expect(
    parseLayoutForTest(JSON.stringify({ inspectorChangesOpen: "bogus" }))
      ?.inspectorChangesOpen
  ).toBe(true);
});

test("notifySound survives a save/load round-trip", () => {
  const layout = { ...DEFAULT_LAYOUT, notifySound: "marimba" as const };
  const restored = parseLayoutForTest(JSON.stringify(layout));
  expect(restored?.notifySound).toBe("marimba");
});

test("an unknown persisted notifySound falls back to default", () => {
  const restored = parseLayoutForTest(
    JSON.stringify({ ...DEFAULT_LAYOUT, notifySound: "airhorn" })
  );
  expect(restored?.notifySound).toBe("default");
});

test("hydrate restores persisted terminals into useTerminals", async () => {
  useTerminals.setState({ byProject: {} });
  mockedListProjects.mockResolvedValue([]);
  mockedListSessions.mockResolvedValue([]);
  const blob = JSON.stringify({
    proj: {
      activeTabId: "t1",
      tabs: [
        {
          activePaneId: "p1",
          direction: "row",
          id: "t1",
          layout: [],
          panes: [{ cwd: "/repo", id: "p1" }],
          title: "dev",
        },
      ],
    },
  });
  mockedLoadLayout.mockImplementation((key: string) =>
    Promise.resolve(key === "terminals" ? blob : null)
  );

  await hydrate();

  expect(useTerminals.getState().byProject.proj.tabs[0].title).toBe("dev");
});

test("parseLayout restores session sort, overrides, and manual orders", () => {
  const layout = parseLayoutForTest(
    JSON.stringify({
      manualSessionOrder: { p1: ["b", "a"] },
      projectSortOverrides: { p1: "manual", p2: "name" },
      sessionSort: "name",
    })
  );
  expect(layout?.sessionSort).toBe("name");
  expect(layout?.projectSortOverrides).toEqual({ p1: "manual", p2: "name" });
  expect(layout?.manualSessionOrder).toEqual({ p1: ["b", "a"] });
});

test("parseLayout drops malformed sort values instead of poisoning the store", () => {
  const layout = parseLayoutForTest(
    JSON.stringify({
      manualSessionOrder: { ok: ["a"], bad: [1, 2], worse: "x" },
      projectSortOverrides: { ok: "date", bad: "sideways", worse: 7 },
      sessionSort: "sideways",
    })
  );
  expect(layout?.sessionSort).toBe("date");
  expect(layout?.projectSortOverrides).toEqual({ ok: "date" });
  expect(layout?.manualSessionOrder).toEqual({ ok: ["a"] });
});

test("parseLayout defaults the sort fields when absent (older blob)", () => {
  const layout = parseLayoutForTest(JSON.stringify({ view: "studio" }));
  expect(layout?.sessionSort).toBe("date");
  expect(layout?.projectSortOverrides).toEqual({});
  expect(layout?.manualSessionOrder).toEqual({});
});

test("parseLayout refuses a __proto__ key in the sort records", () => {
  // JSON.parse creates "__proto__" as an own key; naive assignment into a
  // plain object would replace the record's prototype instead of storing an
  // entry — the store must end up clean, with no phantom inherited keys.
  const layout = parseLayoutForTest(
    '{"manualSessionOrder":{"__proto__":["a"],"ok":["b"]},"projectSortOverrides":{"__proto__":"manual","ok":"name"}}'
  );
  expect(layout?.manualSessionOrder).toEqual({ ok: ["b"] });
  expect(Object.getPrototypeOf(layout?.manualSessionOrder)).toBe(
    Object.prototype
  );
  expect(layout?.projectSortOverrides).toEqual({ ok: "name" });
});

test("pruneSortState drops entries for unknown projects and sessions", () => {
  const layout = {
    ...DEFAULT_LAYOUT,
    manualSessionOrder: {
      "/gone/project": ["s1"],
      "/kept/project": ["s-live", "s-dead", "s-live2"],
    },
    projectSortOverrides: {
      "/gone/project": "manual" as const,
      "/kept/project": "name" as const,
    },
    sessionSort: "date" as const,
  };
  const pruned = pruneSortState(
    layout,
    new Set(["/kept/project"]),
    new Set(["s-live", "s-live2"])
  );
  expect(pruned.manualSessionOrder).toEqual({
    "/kept/project": ["s-live", "s-live2"],
  });
  expect(pruned.projectSortOverrides).toEqual({ "/kept/project": "name" });
});

test("pruneSortState returns the same layout when nothing is stale", () => {
  const layout = {
    ...DEFAULT_LAYOUT,
    manualSessionOrder: { "/p": ["s1"] },
    projectSortOverrides: { "/p": "manual" as const },
  };
  expect(pruneSortState(layout, new Set(["/p"]), new Set(["s1"]))).toBe(layout);
});

test("parseLayout round-trips every transcriptView value", () => {
  expect(
    parseLayoutForTest(JSON.stringify({ transcriptView: "changes" }))
      ?.transcriptView
  ).toBe("changes");
  expect(
    parseLayoutForTest(JSON.stringify({ transcriptView: "raw" }))
      ?.transcriptView
  ).toBe("raw");
});

test("parseLayout falls back to raw for a garbage transcriptView", () => {
  // "studio" is a blob written by a build that still had the structured pane;
  // it must degrade to the terminal rather than resurrect a view that is gone.
  expect(
    parseLayoutForTest(JSON.stringify({ transcriptView: "studio" }))
      ?.transcriptView
  ).toBe("raw");
  expect(
    parseLayoutForTest(JSON.stringify({ transcriptView: "bogus" }))
      ?.transcriptView
  ).toBe("raw");
  expect(
    parseLayoutForTest(JSON.stringify({ transcriptView: 7 }))?.transcriptView
  ).toBe("raw");
  expect(parseLayoutForTest(JSON.stringify({}))?.transcriptView).toBe("raw");
});

test("parseLayout restores a manual project order and defaults it to []", () => {
  const restored = parseLayoutForTest(
    JSON.stringify({ manualProjectOrder: ["p2", "p1"] })
  );
  expect(restored?.manualProjectOrder).toEqual(["p2", "p1"]);
  // An older blob without the field parses to an empty (mode-driven) order.
  expect(
    parseLayoutForTest(JSON.stringify({ view: "studio" }))?.manualProjectOrder
  ).toEqual([]);
});

test("parseLayout drops a malformed manual project order", () => {
  const restored = parseLayoutForTest(
    JSON.stringify({ manualProjectOrder: ["p1", 7, null] })
  );
  expect(restored?.manualProjectOrder).toEqual([]);
});

test("pruneSortState drops manual-project-order ids for unknown projects", () => {
  const layout = {
    ...DEFAULT_LAYOUT,
    manualProjectOrder: ["/kept", "/gone", "/kept2"],
  };
  const pruned = pruneSortState(
    layout,
    new Set(["/kept", "/kept2"]),
    new Set()
  );
  expect(pruned.manualProjectOrder).toEqual(["/kept", "/kept2"]);
});

test("parseLayout round-trips hideOlderThan and defaults unknown values to off", () => {
  const withValue = parseLayoutForTest(JSON.stringify({ hideOlderThan: "3d" }));
  expect(withValue?.hideOlderThan).toBe("3d");

  const bogus = parseLayoutForTest(JSON.stringify({ hideOlderThan: "17y" }));
  expect(bogus?.hideOlderThan).toBe("off");

  const absent = parseLayoutForTest(JSON.stringify({}));
  expect(absent?.hideOlderThan).toBe("off");
});

test("parseLayout keeps the preferred session view, falling back to the terminal", () => {
  expect(
    parseLayoutForTest(JSON.stringify({ preferredSessionView: "structured" }))
      ?.preferredSessionView
  ).toBe("structured");
  expect(
    parseLayoutForTest(JSON.stringify({ preferredSessionView: "changes" }))
      ?.preferredSessionView
  ).toBe("raw");
  expect(parseLayoutForTest(JSON.stringify({}))?.preferredSessionView).toBe(
    "raw"
  );
});

test("parseLayout keeps the chosen mascot and hue, falling back to a cobalt Visor", () => {
  expect(parseLayoutForTest(JSON.stringify({ mascot: "hex" }))?.mascot).toBe(
    "hex"
  );
  // The mascots of earlier builds are gone.
  expect(parseLayoutForTest(JSON.stringify({ mascot: "raven" }))?.mascot).toBe(
    "visor"
  );
  expect(
    parseLayoutForTest(JSON.stringify({ mascotHue: "teal" }))?.mascotHue
  ).toBe("teal");
  expect(
    parseLayoutForTest(JSON.stringify({ mascotHue: "plaid" }))?.mascotHue
  ).toBe("cobalt");
});
