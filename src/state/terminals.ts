import { create } from "zustand";
import { disposeSession } from "../terminal/sessionHost.ts";
import { fullyParkedProjectIds, useSessions } from "./sessions.ts";

/**
 * What an intercepted quit would destroy, so the confirmation can name it: a
 * Project terminal running a foreground process, [Session]s mid-turn, and the
 * background commands sessions left running. Quitting stops all of it.
 */
export interface QuitStakes {
  busyTerminals: boolean;
  /** Command lines of running [Background shell]s, across every session. */
  commands: string[];
  /** How many sessions are still starting Claude up. */
  starting: number;
  /** How many sessions are mid-turn. */
  working: number;
}

export interface TerminalPane {
  cwd: string;
  id: string;
}

export interface TerminalTab {
  activePaneId: string;
  direction: "row" | "column";
  id: string;
  /** Pane size percentages, in pane order, saved after a drag; `[]` until the first drag. */
  layout: number[];
  panes: TerminalPane[];
  title: string;
}

export interface ProjectTerminals {
  activeTabId: string;
  tabs: TerminalTab[];
}

export interface TerminalsState {
  /** Panes with a foreground command running, keyed by pane id (ephemeral, not
   *  persisted). Derived from the shell's OSC 133 command markers. */
  busyPanes: Record<string, boolean>;
  byProject: Record<string, ProjectTerminals>;
  /** Reset a pane's dead flag (its shell is being restarted). */
  clearPaneExited: (paneId: string) => void;
  closePane: (projectId: string, tabId: string, paneId: string) => void;
  closeTab: (projectId: string, tabId: string) => void;
  /** Panes whose shell exited underneath the app (ephemeral, not persisted).
   *  Shown as a "Shell exited" overlay with a restart affordance. */
  deadPanes: Record<string, boolean>;
  hasBusyPanes: () => boolean;
  hydrate: (byProject: Record<string, ProjectTerminals>) => void;
  isPaneBusy: (paneId: string) => boolean;
  isPaneDead: (paneId: string) => boolean;
  isTabBusy: (projectId: string, tabId: string) => boolean;
  livePaneCount: () => number;
  openTab: (projectId: string, cwd: string) => string;
  /** What the quit the user asked for would destroy, or `null` when no quit is
   *  pending — drives the confirm dialog (ephemeral). The store only carries the
   *  stakes; working them out (which needs session state too) belongs to the
   *  quit gate in `terminal/closeOnQuit`. */
  quitConfirm: QuitStakes | null;
  renameTab: (projectId: string, tabId: string, title: string) => void;
  setActivePane: (projectId: string, tabId: string, paneId: string) => void;
  setActiveTab: (projectId: string, tabId: string) => void;
  setDirection: (
    projectId: string,
    tabId: string,
    direction: "row" | "column"
  ) => void;
  setLayout: (projectId: string, tabId: string, layout: number[]) => void;
  setPaneBusy: (paneId: string, busy: boolean) => void;
  /** Mark a pane's shell as exited (also clears its busy flag). */
  setPaneExited: (paneId: string) => void;
  setQuitConfirm: (stakes: QuitStakes | null) => void;
  splitPane: (projectId: string, tabId: string, cwd: string) => string;
  /** Stop every pane of a [Parked project], keeping its tabs and layout so
   *  unparking brings them back; each pane opens a fresh shell when shown. */
  stopProject: (projectId: string) => void;
}

function newPane(cwd: string): TerminalPane {
  return { cwd, id: crypto.randomUUID() };
}

/**
 * The `layout` from a split: the new pane (appended last) takes an equal share
 * and the existing panes keep their relative sizes, scaled to make room. An
 * empty layout means the user never dragged the splitter, so it stays empty and
 * react-resizable-panels distributes equally — no point inventing sizes.
 */
function layoutWithAddedPane(layout: number[]): number[] {
  if (layout.length === 0) {
    return [];
  }
  const newShare = 100 / (layout.length + 1);
  const scale = (100 - newShare) / 100;
  return [...layout.map((size) => size * scale), newShare];
}

/**
 * The `layout` after a pane is closed: drop the closed pane's slot and
 * re-normalize the survivors to their prior relative proportions (so closing
 * one pane doesn't resize the rest to equal). An empty or all-zero layout stays
 * empty (auto-distribute).
 */
function layoutWithoutPane(layout: number[], closedIndex: number): number[] {
  if (layout.length === 0) {
    return [];
  }
  const kept = layout.filter((_, i) => i !== closedIndex);
  const total = kept.reduce((sum, size) => sum + size, 0);
  if (total === 0) {
    return [];
  }
  return kept.map((size) => (size / total) * 100);
}

function newTab(title: string, cwd: string): TerminalTab {
  const pane = newPane(cwd);
  return {
    activePaneId: pane.id,
    direction: "row",
    id: crypto.randomUUID(),
    layout: [],
    panes: [pane],
    title,
  };
}

/** Apply `fn` to one project's tab and return a new byProject map (immutable). */
function updateTab(
  byProject: Record<string, ProjectTerminals>,
  projectId: string,
  tabId: string,
  fn: (tab: TerminalTab) => TerminalTab
): Record<string, ProjectTerminals> {
  const project = byProject[projectId];
  if (!project) {
    return byProject;
  }
  return {
    ...byProject,
    [projectId]: {
      ...project,
      tabs: project.tabs.map((t) => (t.id === tabId ? fn(t) : t)),
    },
  };
}

/** Whether `paneId` is a live pane in any project — the guard that keeps
 *  non-terminal ids (e.g. Claude sessions, always "busy" while claude runs) from
 *  ever entering `busyPanes`. */
function paneExists(
  byProject: Record<string, ProjectTerminals>,
  paneId: string
): boolean {
  return Object.values(byProject).some((p) =>
    p.tabs.some((t) => t.panes.some((pane) => pane.id === paneId))
  );
}

/** Drop the busy flags for a set of pane ids, returning a new map (or the same
 *  reference when nothing changed, so subscribers don't churn). */
function pruneBusy(
  busy: Record<string, boolean>,
  paneIds: string[]
): Record<string, boolean> {
  if (!paneIds.some((id) => id in busy)) {
    return busy;
  }
  const next = { ...busy };
  for (const id of paneIds) {
    delete next[id];
  }
  return next;
}

export const useTerminals = create<TerminalsState>((set, get) => ({
  byProject: {},
  busyPanes: {},
  deadPanes: {},
  quitConfirm: null,

  openTab: (projectId, cwd) => {
    const project = get().byProject[projectId];
    const title = `Terminal ${(project?.tabs.length ?? 0) + 1}`;
    const tab = newTab(title, cwd);
    set((state) => {
      const existing = state.byProject[projectId];
      return {
        byProject: {
          ...state.byProject,
          [projectId]: {
            activeTabId: tab.id,
            tabs: [...(existing?.tabs ?? []), tab],
          },
        },
      };
    });
    return tab.id;
  },

  closeTab: (projectId, tabId) => {
    const project = get().byProject[projectId];
    const tab = project?.tabs.find((t) => t.id === tabId);
    if (!tab) {
      return;
    }
    for (const pane of tab.panes) {
      disposeSession(pane.id);
    }
    const closedPaneIds = tab.panes.map((pane) => pane.id);
    set((state) => {
      const p = state.byProject[projectId];
      if (!p) {
        return state;
      }
      const idx = p.tabs.findIndex((t) => t.id === tabId);
      const tabs = p.tabs.filter((t) => t.id !== tabId);
      // Closing the active tab activates its left neighbour (or the first).
      const activeTabId =
        p.activeTabId === tabId
          ? (tabs[Math.max(0, idx - 1)]?.id ?? "")
          : p.activeTabId;
      return {
        busyPanes: pruneBusy(state.busyPanes, closedPaneIds),
        byProject: { ...state.byProject, [projectId]: { activeTabId, tabs } },
        deadPanes: pruneBusy(state.deadPanes, closedPaneIds),
      };
    });
  },

  renameTab: (projectId, tabId, title) =>
    set((state) => ({
      byProject: updateTab(state.byProject, projectId, tabId, (t) => ({
        ...t,
        title,
      })),
    })),

  setActiveTab: (projectId, tabId) =>
    set((state) => {
      const p = state.byProject[projectId];
      if (!p) {
        return state;
      }
      return {
        byProject: {
          ...state.byProject,
          [projectId]: { ...p, activeTabId: tabId },
        },
      };
    }),

  splitPane: (projectId, tabId, cwd) => {
    const pane = newPane(cwd);
    set((state) => ({
      byProject: updateTab(state.byProject, projectId, tabId, (t) => ({
        ...t,
        activePaneId: pane.id,
        layout: layoutWithAddedPane(t.layout),
        panes: [...t.panes, pane],
      })),
    }));
    return pane.id;
  },

  setDirection: (projectId, tabId, direction) =>
    set((state) => ({
      byProject: updateTab(state.byProject, projectId, tabId, (t) => ({
        ...t,
        direction,
      })),
    })),

  closePane: (projectId, tabId, paneId) => {
    const project = get().byProject[projectId];
    const tab = project?.tabs.find((t) => t.id === tabId);
    if (!tab) {
      return;
    }
    disposeSession(paneId);
    if (tab.panes.length <= 1) {
      get().closeTab(projectId, tabId);
      return;
    }
    set((state) => ({
      busyPanes: pruneBusy(state.busyPanes, [paneId]),
      deadPanes: pruneBusy(state.deadPanes, [paneId]),
      byProject: updateTab(state.byProject, projectId, tabId, (t) => {
        const idx = t.panes.findIndex((pane) => pane.id === paneId);
        const panes = t.panes.filter((pane) => pane.id !== paneId);
        // Closing the active pane activates its left neighbour (or the first).
        const activePaneId =
          t.activePaneId === paneId
            ? (panes[Math.max(0, idx - 1)]?.id ?? "")
            : t.activePaneId;
        return {
          ...t,
          activePaneId,
          layout: layoutWithoutPane(t.layout, idx),
          panes,
        };
      }),
    }));
  },

  setActivePane: (projectId, tabId, paneId) =>
    set((state) => ({
      byProject: updateTab(state.byProject, projectId, tabId, (t) => ({
        ...t,
        activePaneId: paneId,
      })),
    })),

  setLayout: (projectId, tabId, layout) =>
    set((state) => ({
      byProject: updateTab(state.byProject, projectId, tabId, (t) => ({
        ...t,
        layout,
      })),
    })),

  livePaneCount: () =>
    Object.values(get().byProject).reduce(
      (sum, p) => sum + p.tabs.reduce((n, t) => n + t.panes.length, 0),
      0
    ),

  setPaneBusy: (paneId, busy) =>
    set((state) => {
      // Only track ids that are real panes; a busy signal for a Claude session
      // (or a since-closed pane) must never enter the map. Clearing is always
      // allowed so a stale entry can't get stuck.
      if (busy && !paneExists(state.byProject, paneId)) {
        return state;
      }
      if ((state.busyPanes[paneId] === true) === busy) {
        return state;
      }
      const next = { ...state.busyPanes };
      if (busy) {
        next[paneId] = true;
      } else {
        delete next[paneId];
      }
      return { busyPanes: next };
    }),

  setPaneExited: (paneId) =>
    set((state) => {
      // Same guard as busy: only ids that are live panes may enter the map —
      // a Claude session's shell dying is handled by its own activation
      // revive, not the dock's dead-pane overlay.
      if (!paneExists(state.byProject, paneId)) {
        return state;
      }
      return {
        busyPanes: pruneBusy(state.busyPanes, [paneId]),
        deadPanes: { ...state.deadPanes, [paneId]: true },
      };
    }),

  clearPaneExited: (paneId) =>
    set((state) => {
      if (state.deadPanes[paneId] !== true) {
        return state;
      }
      return { deadPanes: pruneBusy(state.deadPanes, [paneId]) };
    }),

  isPaneDead: (paneId) => get().deadPanes[paneId] === true,

  setQuitConfirm: (stakes) => set({ quitConfirm: stakes }),

  isPaneBusy: (paneId) => get().busyPanes[paneId] === true,

  isTabBusy: (projectId, tabId) => {
    const busy = get().busyPanes;
    const tab = get().byProject[projectId]?.tabs.find((t) => t.id === tabId);
    return tab?.panes.some((pane) => busy[pane.id] === true) ?? false;
  },

  hasBusyPanes: () => Object.keys(get().busyPanes).length > 0,

  hydrate: (byProject) => set({ byProject }),

  stopProject: (projectId) => {
    const paneIds = projectPaneIds(get().byProject, projectId);
    for (const id of paneIds) {
      disposeSession(id);
    }
    set((state) => ({
      busyPanes: pruneBusy(state.busyPanes, paneIds),
      deadPanes: pruneBusy(state.deadPanes, paneIds),
    }));
  },
}));

/** Every [Terminal pane] id a project owns, across all its tabs. */
export function projectPaneIds(
  byProject: Record<string, ProjectTerminals>,
  projectId: string
): string[] {
  return (
    byProject[projectId]?.tabs.flatMap((tab) =>
      tab.panes.map((pane) => pane.id)
    ) ?? []
  );
}

/**
 * Stop a project's [Project terminal]s the moment it becomes fully parked —
 * whichever way it got there: *Park project*, or closing or archiving the one
 * session still on the rail after the rest were parked. The dock unmounts a
 * fully parked project's workspace, so a command left running there would be
 * out of sight and out of reach. Keyed on the state, not on the actions that
 * reach it, so a new way to get there can't forget. Returns the unsubscribe.
 */
export function installParkedTerminalStops(): () => void {
  let parked = fullyParkedProjectIds(useSessions.getState().sessions);
  let seen = useSessions.getState().sessions;
  return useSessions.subscribe((state) => {
    if (state.sessions === seen) {
      return;
    }
    seen = state.sessions;
    const next = fullyParkedProjectIds(state.sessions);
    for (const projectId of next) {
      if (!parked.has(projectId)) {
        useTerminals.getState().stopProject(projectId);
      }
    }
    parked = next;
  });
}
