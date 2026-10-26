import { create } from "zustand";
import { DEFAULT_THEME_ID } from "../theme/themes/index.ts";
import type { NotifyPreference, NotifySound } from "../types.ts";

/**
 * How the sidebar organizes its session list. `calm` keeps the current
 * structure, just recolored so only work needing the user carries color;
 * `triage` floats active work up and folds read Done into a per-project
 * summary. User-switchable from the command center.
 */
export type SidebarMode = "calm" | "triage";

/** Menu-bar popover layout: sectioned groups vs one dense list. */
export type MenuBarMode = "compact" | "grouped";

/** How sessions inside a project group are ordered. */
export type SessionSort = "manual" | "date" | "name";

/** How aggressively the sidebar folds away stale sessions. `off` hides none. */
export type HideOlderThan = "off" | "1h" | "6h" | "1d" | "3d" | "1w";

/** How long a session must sit idle before it is slept. `off` never sleeps. */
export type AutoSleepAfter = "off" | "1h" | "3h" | "6h";

/** The [Nested session cap]: how many sessions may be running before one
 *  Claude asks to start is shown as a suggestion instead. */
export type NestedSessionCap = "off" | "2" | "4" | "6";

/** The cap as a number, or `null` when there is none. */
export function nestedCapCount(cap: NestedSessionCap): number | null {
  return cap === "off" ? null : Number(cap);
}

/** [Sleeping session] thresholds in seconds, keyed by the setting value. */
export const AUTO_SLEEP_SECS: Record<Exclude<AutoSleepAfter, "off">, number> = {
  "1h": 3600,
  "3h": 3 * 3600,
  "6h": 6 * 3600,
};

/**
 * The window's UI layout: which view is showing, the sidebar width, collapsed
 * project groups, and the notify preference. Split out of the session store —
 * it is orthogonal to session lifecycle and transcript churn, so a component
 * that only wants the sidebar width no longer subscribes to the store that owns
 * the event ring and live snapshots.
 */
export interface Layout {
  /** Sleep a session's `claude` after this much idle time; pushed on change. */
  autoSleepAfter: AutoSleepAfter;
  /** Projects whose sidebar group is collapsed; absent means expanded. */
  collapsedProjectIds: string[];
  /** Composer hidden to a slim reveal strip (terminal-first working style). */
  composerCollapsed: boolean;
  /** Fold sessions whose last activity predates this cutoff into a per-group
   *  "N older" disclosure; `off` shows all. */
  hideOlderThan: HideOlderThan;
  /** Inspector's Changes section expanded vs collapsed (CollapsibleSection). */
  inspectorChangesOpen: boolean;
  /** Inspector collapsed to its 46px icon rail. */
  inspectorCollapsed: boolean;
  /** Drag-arranged project-id order. When non-empty it wins over the sidebar
   *  mode's ordering (both calm and triage) — the user's arrangement is the
   *  order, in every mode. Empty means "no manual order; follow the mode". */
  manualProjectOrder: string[];
  /** Per-project drag-arranged session-id order, used by `manual` sort. */
  manualSessionOrder: Record<string, string[]>;
  /** The [Mascot] at the top of the Structured view, or none. */
  mascot: MascotId;
  /** The hue it is drawn in. */
  mascotHue: MascotHue;
  /** [Memory budget] in MB above which the backend warns; pushed on change. */
  memoryBudgetMb: number;
  /** Whether the over-budget memory warning fires; pushed on change. */
  memoryWarnEnabled: boolean;
  /** Menu-bar popover layout: sectioned groups vs one dense list. */
  menuBarMode: MenuBarMode;
  /** The [Nested session cap]. */
  nestedSessionCap: NestedSessionCap;
  /** Cross-project OS-notification policy, pushed to the backend on change. */
  notifyPreference: NotifyPreference;
  /** Chosen OS-notification sound, pushed to the backend on change. */
  notifySound: NotifySound;
  /** The view a session opens in and comes back to: the terminal or the
   *  Structured view, whichever the user last picked ([Preferred session view]). */
  preferredSessionView: SessionView;
  /** Per-project sort override; absent = follow the global `sessionSort`. */
  projectSortOverrides: Record<string, SessionSort>;
  /** Global session sort inside each project group. */
  sessionSort: SessionSort;
  /** Sidebar hidden entirely (the title-bar toggle brings it back). */
  sidebarCollapsed: boolean;
  /** How the sidebar orders and calms its session list. */
  sidebarMode: SidebarMode;
  /** Sidebar rail width in px, user-resizable within the clamp range. */
  sidebarWidth: number;
  /** Bottom Project-terminal dock fills the working column (sidebar stays). */
  terminalDockFullHeight: boolean;
  /** Bottom Project-terminal dock height in px, user-resizable within the clamp range. */
  terminalDockHeight: number;
  /** Bottom Project-terminal dock is open. */
  terminalDockOpen: boolean;
  /** Active theme id from the theme registry (`src/theme/themes/`). */
  themeId: string;
  transcriptView: TranscriptView;
  view: "studio" | "focus" | "command" | "prompts" | "settings";
}

/** The [Mascot]s a user can pick, and `none` for no mascot. */
export type MascotId = "visor" | "gem" | "hex" | "none";

/** The hues a [Mascot] can be drawn in (`tokens.mascot.hues`). */
export type MascotHue =
  | "cobalt"
  | "violet"
  | "teal"
  | "amber"
  | "rose"
  | "graphite";

/** The transcript views a session opens in. Changes is visited, not opened in. */
export type SessionView = Exclude<TranscriptView, "changes">;

/** Which transcript pane is showing: the Code Changes View or the raw
 * terminal. Mirrors `SessionHeader`'s tab order (Changes, Raw), which
 * `toggleTranscriptView` flips between. */
export type TranscriptView = "changes" | "raw" | "structured";

export const SIDEBAR_WIDTH_DEFAULT = 278;
export const SIDEBAR_WIDTH_MIN = 220;
export const SIDEBAR_WIDTH_MAX = 420;

export const TERMINAL_DOCK_HEIGHT_DEFAULT = 260;
export const TERMINAL_DOCK_HEIGHT_MIN = 120;
export const TERMINAL_DOCK_HEIGHT_MAX = 640;

/** Clamp a requested sidebar width into the resizable range. */
export function clampSidebarWidth(width: number): number {
  return Math.min(SIDEBAR_WIDTH_MAX, Math.max(SIDEBAR_WIDTH_MIN, width));
}

/** Clamp a requested terminal dock height into the resizable range. */
export function clampTerminalDockHeight(height: number): number {
  return Math.min(
    TERMINAL_DOCK_HEIGHT_MAX,
    Math.max(TERMINAL_DOCK_HEIGHT_MIN, height)
  );
}

/** The sort a project group actually uses: its override, else the global. */
export function effectiveSessionSort(
  layout: Layout,
  projectId: string
): SessionSort {
  return layout.projectSortOverrides[projectId] ?? layout.sessionSort;
}

/** The layout every fresh launch starts from, before persisted state hydrates. */
export const DEFAULT_LAYOUT: Layout = {
  autoSleepAfter: "3h",
  collapsedProjectIds: [],
  composerCollapsed: false,
  hideOlderThan: "off",
  inspectorChangesOpen: true,
  inspectorCollapsed: false,
  manualProjectOrder: [],
  manualSessionOrder: {},
  memoryBudgetMb: 6144,
  memoryWarnEnabled: true,
  menuBarMode: "grouped",
  nestedSessionCap: "4",
  notifyPreference: "all",
  notifySound: "default",
  projectSortOverrides: {},
  sessionSort: "date",
  sidebarCollapsed: false,
  sidebarMode: "calm",
  sidebarWidth: SIDEBAR_WIDTH_DEFAULT,
  terminalDockFullHeight: false,
  terminalDockHeight: TERMINAL_DOCK_HEIGHT_DEFAULT,
  terminalDockOpen: false,
  themeId: DEFAULT_THEME_ID,
  preferredSessionView: "raw",
  mascot: "visor",
  mascotHue: "cobalt",
  transcriptView: "raw",
  view: "studio",
};

/** The inspector's two tabs: what the session is, and what Claude did in it. */
export type InspectorTab = "details" | "activity";

interface LayoutState {
  /** The inspector's open tab. Not saved: a launch opens on Details. */
  inspectorTab: InspectorTab;
  layout: Layout;
  /** Return `transcriptView` to the terminal; a no-op unless the current
   *  view is `"changes"`. */
  leaveChangesView: () => void;
  /**
   * Show the session the user just picked: return to the session view and
   * leave the Changes tab.
   *
   * Every "open this session" path needs this now. The sidebar used to live
   * inside the session view and vanish with it, so a click on a session row
   * could only ever happen while that view was already showing; since
   * ADR-0023 the sidebar outlives the view, and the same click can arrive
   * from Settings, Prompts or the Command centre — where, without this, it
   * changed the active session behind a full-screen view and looked like it
   * had done nothing.
   */
  revealSessionView: () => void;
  setAutoSleepAfter: (value: AutoSleepAfter) => void;
  setHideOlderThan: (value: HideOlderThan) => void;
  setInspectorChangesOpen: (open: boolean) => void;
  setInspectorTab: (tab: InspectorTab) => void;
  setManualProjectOrder: (orderedIds: string[]) => void;
  setManualSessionOrder: (projectId: string, orderedIds: string[]) => void;
  setMascot: (mascot: MascotId) => void;
  setMascotHue: (hue: MascotHue) => void;
  setMemoryBudgetMb: (budgetMb: number) => void;
  setMemoryWarnEnabled: (enabled: boolean) => void;
  setMenuBarMode: (mode: Layout["menuBarMode"]) => void;
  setNestedSessionCap: (cap: NestedSessionCap) => void;
  setNotifyPreference: (pref: NotifyPreference) => void;
  setNotifySound: (sound: NotifySound) => void;
  setProjectSort: (projectId: string, mode: SessionSort | null) => void;
  setSessionSort: (mode: SessionSort) => void;
  setSidebarMode: (mode: SidebarMode) => void;
  setSidebarWidth: (width: number) => void;
  setTerminalDockHeight: (height: number) => void;
  setThemeId: (themeId: string) => void;
  /** Show `view`. Picking the terminal or the Structured view makes it the
   *  [Preferred session view] unless `remember` is false (a detour the user
   *  didn't choose, like the terminal a permission prompt needs). */
  setTranscriptView: (view: TranscriptView, remember?: boolean) => void;
  setView: (view: Layout["view"]) => void;
  /**
   * Put the session view on screen without touching the tab the user is on —
   * what an "open this session" path wants when it has its own opinion about
   * the tab, or none at all (the Command centre's standing rows).
   *
   * Focus is left alone: it shows sessions too, and yanking the user out of
   * it to reveal what it is already displaying would be the same bug in the
   * other direction.
   */
  showSessionView: () => void;
  toggleComposerCollapsed: () => void;
  toggleInspectorCollapsed: () => void;
  toggleProjectCollapsed: (projectId: string) => void;
  toggleSidebarCollapsed: () => void;
  toggleTerminalDock: () => void;
  toggleTerminalDockFullHeight: () => void;
  toggleTranscriptView: () => void;
  toggleView: () => void;
}

export const useLayout = create<LayoutState>((set, get) => ({
  inspectorTab: "details",
  layout: DEFAULT_LAYOUT,
  setView: (view) => set((state) => ({ layout: { ...state.layout, view } })),
  setSidebarWidth: (width) =>
    set((state) => ({
      layout: { ...state.layout, sidebarWidth: clampSidebarWidth(width) },
    })),
  toggleComposerCollapsed: () =>
    set((state) => ({
      layout: {
        ...state.layout,
        composerCollapsed: !state.layout.composerCollapsed,
      },
    })),
  toggleInspectorCollapsed: () =>
    set((state) => ({
      layout: {
        ...state.layout,
        inspectorCollapsed: !state.layout.inspectorCollapsed,
      },
    })),
  toggleSidebarCollapsed: () =>
    set((state) => ({
      layout: {
        ...state.layout,
        sidebarCollapsed: !state.layout.sidebarCollapsed,
      },
    })),
  toggleProjectCollapsed: (projectId) =>
    set((state) => {
      const collapsed = state.layout.collapsedProjectIds;
      const collapsedProjectIds = collapsed.includes(projectId)
        ? collapsed.filter((id) => id !== projectId)
        : [...collapsed, projectId];
      return { layout: { ...state.layout, collapsedProjectIds } };
    }),
  toggleTerminalDock: () =>
    set((state) => ({
      layout: {
        ...state.layout,
        terminalDockOpen: !state.layout.terminalDockOpen,
      },
    })),
  setTerminalDockHeight: (height) =>
    set((state) => ({
      layout: {
        ...state.layout,
        terminalDockHeight: clampTerminalDockHeight(height),
      },
    })),
  toggleTerminalDockFullHeight: () =>
    set((state) => ({
      layout: {
        ...state.layout,
        terminalDockFullHeight: !state.layout.terminalDockFullHeight,
      },
    })),
  setManualProjectOrder: (orderedIds) =>
    set((state) => ({
      layout: { ...state.layout, manualProjectOrder: orderedIds },
    })),
  setManualSessionOrder: (projectId, orderedIds) =>
    set((state) => {
      const layout = {
        ...state.layout,
        manualSessionOrder: {
          ...state.layout.manualSessionOrder,
          [projectId]: orderedIds,
        },
      };
      // A drop must stick regardless of the global mode — pin the project to
      // manual unless it already resolves to manual.
      if (effectiveSessionSort(state.layout, projectId) !== "manual") {
        layout.projectSortOverrides = {
          ...state.layout.projectSortOverrides,
          [projectId]: "manual",
        };
      }
      return { layout };
    }),
  setAutoSleepAfter: (autoSleepAfter) =>
    set((state) => ({ layout: { ...state.layout, autoSleepAfter } })),
  setHideOlderThan: (hideOlderThan) =>
    set((state) => ({ layout: { ...state.layout, hideOlderThan } })),
  setInspectorChangesOpen: (inspectorChangesOpen) =>
    set((state) => ({ layout: { ...state.layout, inspectorChangesOpen } })),
  setInspectorTab: (inspectorTab) => set({ inspectorTab }),
  setMemoryBudgetMb: (memoryBudgetMb) =>
    set((state) => ({ layout: { ...state.layout, memoryBudgetMb } })),
  setNestedSessionCap: (nestedSessionCap) =>
    set((state) => ({ layout: { ...state.layout, nestedSessionCap } })),
  setMemoryWarnEnabled: (memoryWarnEnabled) =>
    set((state) => ({ layout: { ...state.layout, memoryWarnEnabled } })),
  setMenuBarMode: (menuBarMode) =>
    set((state) => ({ layout: { ...state.layout, menuBarMode } })),
  setNotifyPreference: (notifyPreference) =>
    set((state) => ({ layout: { ...state.layout, notifyPreference } })),
  setNotifySound: (notifySound) =>
    set((state) => ({ layout: { ...state.layout, notifySound } })),
  setProjectSort: (projectId, mode) =>
    set((state) => {
      const overrides = { ...state.layout.projectSortOverrides };
      if (mode === null) {
        delete overrides[projectId];
      } else {
        overrides[projectId] = mode;
      }
      return { layout: { ...state.layout, projectSortOverrides: overrides } };
    }),
  setSessionSort: (sessionSort) =>
    set((state) => ({
      // Changing the global resets every per-project choice (design rule);
      // manual arrangements are positions, not a mode, so they survive.
      layout: { ...state.layout, projectSortOverrides: {}, sessionSort },
    })),
  setSidebarMode: (sidebarMode) =>
    set((state) => ({ layout: { ...state.layout, sidebarMode } })),
  setMascot: (mascot) =>
    set((state) => ({ layout: { ...state.layout, mascot } })),
  setMascotHue: (mascotHue) =>
    set((state) => ({ layout: { ...state.layout, mascotHue } })),
  setThemeId: (themeId) =>
    set((state) => ({ layout: { ...state.layout, themeId } })),
  setTranscriptView: (transcriptView, remember = true) =>
    set((state) => ({
      layout: {
        ...state.layout,
        preferredSessionView:
          transcriptView === "changes" || !remember
            ? state.layout.preferredSessionView
            : transcriptView,
        transcriptView,
      },
    })),
  leaveChangesView: () =>
    set((state) => {
      if (state.layout.transcriptView !== "changes") {
        return state;
      }
      return {
        layout: {
          ...state.layout,
          transcriptView: state.layout.preferredSessionView,
        },
      };
    }),
  revealSessionView: () => {
    get().showSessionView();
    get().setTranscriptView(get().layout.preferredSessionView);
  },
  showSessionView: () =>
    set((state) => {
      const showsSessions =
        state.layout.view === "studio" || state.layout.view === "focus";
      return {
        layout: {
          ...state.layout,
          view: showsSessions ? state.layout.view : "studio",
        },
      };
    }),
  toggleView: () =>
    set((state) => ({
      layout: {
        ...state.layout,
        view: state.layout.view === "studio" ? "focus" : "studio",
      },
    })),
  toggleTranscriptView: () => {
    const { preferredSessionView, transcriptView } = get().layout;
    get().setTranscriptView(
      transcriptView === "changes" ? preferredSessionView : "changes"
    );
  },
}));
