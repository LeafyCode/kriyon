import {
  listProjects,
  listPrompts,
  listSessions,
  loadLayout,
  saveLayout,
  upsertProject,
  upsertSession,
} from "../ipc/bridge.ts";
import { themeById } from "../theme/themes/index.ts";
import type {
  NotifyPreference,
  NotifySound,
  ProjectRow,
  SessionRow,
} from "../types.ts";
import {
  clampSidebarWidth,
  clampTerminalDockHeight,
  DEFAULT_LAYOUT,
  type HideOlderThan,
  isNestedCap,
  type Layout,
  type SessionSort,
  SIDEBAR_WIDTH_DEFAULT,
  TERMINAL_DOCK_HEIGHT_DEFAULT,
  useLayout,
} from "./layout.ts";
import { usePromptLibrary } from "./promptLibrary.ts";
import {
  idleSession,
  isPutAway,
  sessionRow,
  type UiSession,
  useSessions,
} from "./sessions.ts";
import { type ProjectTerminals, useTerminals } from "./terminals.ts";

const LAYOUT_KEY = "layout";
const TERMINALS_KEY = "terminals";
const PERSIST_DEBOUNCE_MS = 300;

function ignore(promise: Promise<unknown>): void {
  promise.catch((error) => {
    // Fire-and-forget IPC; persistence errors are non-fatal — but they are
    // real data loss (a drag-arranged order, a renamed session), so they must
    // at least leave a trace instead of vanishing.
    // biome-ignore lint/suspicious/noConsole: a swallowed persistence failure is silent data loss.
    console.error("persistence write failed", error);
  });
}

/**
 * The file's dominant validator shape, as a combinator: a persisted value is
 * valid iff it is one of `values`, else `fallback`. Every enum-shaped layout
 * field parses through this — one implementation, one behavior, instead of a
 * hand-written copy per field.
 */
function oneOf<T extends string>(
  values: readonly T[],
  fallback: T
): (value: unknown) => T {
  return (value) => (values.includes(value as T) ? (value as T) : fallback);
}

/**
 * Boolean field parsed with an explicit default: a real `boolean` passes
 * through, anything else (missing key, wrong type, corrupt blob) falls back
 * to `fallback`. Most existing boolean fields default to `false` via a bare
 * `=== true` check; a field that must default to `true` needs its own
 * combinator instead of overloading that shape with the opposite polarity.
 */
function booleanOr(fallback: boolean): (value: unknown) => boolean {
  return (value) => (typeof value === "boolean" ? value : fallback);
}

/**
 * `JSON.parse` yields `__proto__` as an own key; assigning it into a plain
 * object replaces the object's prototype instead of storing an entry. Skip it
 * (and any prototype-plumbing key) so a hostile or corrupt blob cannot give
 * the record phantom inherited keys.
 */
function safeRecordKey(key: string): boolean {
  return key !== "__proto__" && key !== "constructor" && key !== "prototype";
}

/**
 * Combinator for record-shaped blobs: keeps entries whose key is
 * prototype-safe and whose value `valid` accepts (return `undefined` to
 * drop). Arrays and non-objects parse to `{}`. Centralizes the `__proto__`
 * and top-level-array defenses so a new record field can't forget them.
 */
function recordOf<V>(
  valid: (value: unknown) => V | undefined
): (value: unknown) => Record<string, V> {
  return (value) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return {};
    }
    const out: Record<string, V> = {};
    for (const [key, entry] of Object.entries(value)) {
      const validated = valid(entry);
      if (safeRecordKey(key) && validated !== undefined) {
        out[key] = validated;
      }
    }
    return out;
  };
}

const NOTIFY_SOUNDS: readonly NotifySound[] = [
  "default",
  "silent",
  "marimba",
  "music_box",
  "vibraphone",
  "kalimba",
  "bell",
];

const LAYOUT_VIEWS: readonly Layout["view"][] = [
  "studio",
  "focus",
  "command",
  "prompts",
  "settings",
];

// Derived from an exhaustive Record so adding a SessionSort member without
// covering it here is a compile error — a bare `readonly SessionSort[]` would
// accept an incomplete list and silently drop the new mode's persistence.
const SESSION_SORT_SET: Record<SessionSort, true> = {
  date: true,
  manual: true,
  name: true,
};
const SESSION_SORTS = Object.keys(SESSION_SORT_SET) as readonly SessionSort[];

const parseNotifyPreference = oneOf<NotifyPreference>(
  ["all", "only_blocked", "none"],
  "all"
);
const parseNotifySound = oneOf<NotifySound>(NOTIFY_SOUNDS, "default");
const parseMenuBarMode = oneOf<Layout["menuBarMode"]>(
  ["grouped", "compact"],
  "grouped"
);
const parseSidebarMode = oneOf<Layout["sidebarMode"]>(
  ["calm", "triage"],
  "calm"
);
const parseView = oneOf<Layout["view"]>(LAYOUT_VIEWS, "studio");
const parseSessionSort = oneOf<SessionSort>(SESSION_SORTS, "date");
const parseInspectorChangesOpen = booleanOr(true);

// Derived from an exhaustive Record so adding a transcriptView member without
// covering it here is a compile error — a bare `readonly [...][]` would accept
// an incomplete list and silently coerce the new value back to the fallback.
const TRANSCRIPT_VIEW_SET: Record<Layout["transcriptView"], true> = {
  changes: true,
  raw: true,
  structured: true,
};
const TRANSCRIPT_VIEWS = Object.keys(
  TRANSCRIPT_VIEW_SET
) as readonly Layout["transcriptView"][];
const parseTranscriptView = oneOf<Layout["transcriptView"]>(
  TRANSCRIPT_VIEWS,
  "raw"
);
// A mascot that is gone (the raven, pangolin, ribbon and orb of earlier
// builds) falls back to the Visor.
const parseMascot = oneOf<Layout["mascot"]>(
  ["visor", "gem", "hex", "none"],
  "visor"
);
const parseMascotHue = oneOf<Layout["mascotHue"]>(
  ["cobalt", "violet", "teal", "amber", "rose", "graphite"],
  "cobalt"
);
const parseSessionView = oneOf<Layout["preferredSessionView"]>(
  ["raw", "structured"],
  "raw"
);

// Derived from an exhaustive Record so adding a HideOlderThan member without
// covering it here is a compile error — a bare `readonly HideOlderThan[]` would
// accept an incomplete list and silently drop the new value's persistence.
const HIDE_OLDER_SET: Record<HideOlderThan, true> = {
  "1d": true,
  "1h": true,
  "1w": true,
  "3d": true,
  "6h": true,
  off: true,
};
const HIDE_OLDER_VALUES = Object.keys(
  HIDE_OLDER_SET
) as readonly HideOlderThan[];
const parseHideOlderThan = oneOf<HideOlderThan>(HIDE_OLDER_VALUES, "off");

/** Per-project sort override: entries must be a valid {@link SessionSort}. */
const parseSortOverrides = recordOf<SessionSort>((value) =>
  SESSION_SORTS.includes(value as SessionSort)
    ? (value as SessionSort)
    : undefined
);

/** Per-project manual order: entries must be arrays of session-id strings. */
const parseManualOrders = recordOf<string[]>((value) =>
  Array.isArray(value) && value.every((id) => typeof id === "string")
    ? (value as string[])
    : undefined
);

/** The [Nested session cap]: `null` for none, else a whole number in range.
 *  Older builds saved the choice as text ("off", "2", "4", "6"). */
function parseNestedSessionCap(value: unknown): Layout["nestedSessionCap"] {
  if (value === null || value === "off") {
    return null;
  }
  const cap = typeof value === "string" ? Number(value) : value;
  return isNestedCap(cap) ? cap : DEFAULT_LAYOUT.nestedSessionCap;
}

/** The global manual project order: an array of project-id strings, else []. */
function parseManualProjectOrder(value: unknown): string[] {
  return Array.isArray(value) && value.every((id) => typeof id === "string")
    ? (value as string[])
    : [];
}

/**
 * Drop sort state pointing at projects or sessions that no longer exist.
 * The maps otherwise only ever grow (nothing deletes an entry when a session
 * or project goes away), so each hydrate re-anchors them to reality. Returns
 * the same layout object when nothing is stale, so hydrate's setState can't
 * cause a spurious re-render.
 */
export function pruneSortState(
  layout: Layout,
  projectIds: ReadonlySet<string>,
  sessionIds: ReadonlySet<string>
): Layout {
  const overrides: Record<string, SessionSort> = {};
  let prunedAny = false;
  for (const [projectId, mode] of Object.entries(layout.projectSortOverrides)) {
    if (projectIds.has(projectId)) {
      overrides[projectId] = mode;
    } else {
      prunedAny = true;
    }
  }
  const orders: Record<string, string[]> = {};
  for (const [projectId, ids] of Object.entries(layout.manualSessionOrder)) {
    if (!projectIds.has(projectId)) {
      prunedAny = true;
      continue;
    }
    const live = ids.filter((id) => sessionIds.has(id));
    orders[projectId] = live;
    prunedAny ||= live.length !== ids.length;
  }
  // The manual project order only ever grows; drop ids for projects that no
  // longer exist so a deleted project can't wedge a phantom slot.
  const projectOrder = layout.manualProjectOrder.filter((id) =>
    projectIds.has(id)
  );
  prunedAny ||= projectOrder.length !== layout.manualProjectOrder.length;
  if (!prunedAny) {
    return layout;
  }
  return {
    ...layout,
    manualProjectOrder: projectOrder,
    manualSessionOrder: orders,
    projectSortOverrides: overrides,
  };
}

export function parseLayout(json: string | null): Layout | undefined {
  if (!json) {
    return;
  }
  let parsed: Partial<Layout>;
  try {
    parsed = JSON.parse(json) as Partial<Layout>;
  } catch {
    // Malformed layout JSON: keep the default layout.
    return;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return;
  }
  // Each field is validated independently, so one unrecognized value (e.g. a
  // view added in a newer build) can never discard the rest of the layout.
  return {
    collapsedProjectIds: Array.isArray(parsed.collapsedProjectIds)
      ? parsed.collapsedProjectIds
      : [],
    composerCollapsed: parsed.composerCollapsed === true,
    hideOlderThan: parseHideOlderThan(parsed.hideOlderThan),
    inspectorChangesOpen: parseInspectorChangesOpen(
      parsed.inspectorChangesOpen
    ),
    inspectorCollapsed: parsed.inspectorCollapsed === true,
    manualProjectOrder: parseManualProjectOrder(parsed.manualProjectOrder),
    manualSessionOrder: parseManualOrders(parsed.manualSessionOrder),
    menuBarMode: parseMenuBarMode(parsed.menuBarMode),
    nestedSessionCap: parseNestedSessionCap(parsed.nestedSessionCap),
    autoSleepAfter:
      parsed.autoSleepAfter === "off" ||
      parsed.autoSleepAfter === "1h" ||
      parsed.autoSleepAfter === "3h" ||
      parsed.autoSleepAfter === "6h"
        ? parsed.autoSleepAfter
        : DEFAULT_LAYOUT.autoSleepAfter,
    memoryBudgetMb:
      typeof parsed.memoryBudgetMb === "number" &&
      Number.isFinite(parsed.memoryBudgetMb) &&
      parsed.memoryBudgetMb >= 1024
        ? Math.round(parsed.memoryBudgetMb)
        : DEFAULT_LAYOUT.memoryBudgetMb,
    memoryWarnEnabled: parsed.memoryWarnEnabled !== false,
    notifyPreference: parseNotifyPreference(parsed.notifyPreference),
    notifySound: parseNotifySound(parsed.notifySound),
    projectSortOverrides: parseSortOverrides(parsed.projectSortOverrides),
    sessionSort: parseSessionSort(parsed.sessionSort),
    sidebarCollapsed: parsed.sidebarCollapsed === true,
    sidebarMode: parseSidebarMode(parsed.sidebarMode),
    sidebarWidth:
      typeof parsed.sidebarWidth === "number"
        ? clampSidebarWidth(parsed.sidebarWidth)
        : SIDEBAR_WIDTH_DEFAULT,
    terminalDockFullHeight: parsed.terminalDockFullHeight === true,
    terminalDockHeight:
      typeof parsed.terminalDockHeight === "number"
        ? clampTerminalDockHeight(parsed.terminalDockHeight)
        : TERMINAL_DOCK_HEIGHT_DEFAULT,
    terminalDockOpen: parsed.terminalDockOpen === true,
    // themeById maps an unknown or stale id back to the default theme.
    themeId: themeById(
      typeof parsed.themeId === "string" ? parsed.themeId : undefined
    ).id,
    preferredSessionView: parseSessionView(parsed.preferredSessionView),
    mascot: parseMascot(parsed.mascot),
    mascotHue: parseMascotHue(parsed.mascotHue),
    transcriptView: parseTranscriptView(parsed.transcriptView),
    view: parseView(parsed.view),
  };
}

/**
 * Restore per-project terminal structure (tabs/panes), validating each project
 * entry has a `tabs` array so a non-terminals blob (e.g. a layout object under a
 * key-agnostic loader) can never poison the store. Live processes are not
 * restored — restored panes re-spawn fresh shells on mount (die-on-quit).
 */
function parseTerminals(
  json: string | null
): Record<string, ProjectTerminals> | undefined {
  if (!json) {
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return;
  }
  const out: Record<string, ProjectTerminals> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (
      value &&
      typeof value === "object" &&
      Array.isArray((value as ProjectTerminals).tabs)
    ) {
      out[key] = value as ProjectTerminals;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Loads persisted projects, sessions, and layout from the backend and
 * populates the store. Does not run automatically at import time.
 */
export async function hydrate(): Promise<void> {
  // The prompt library must never block core hydration: its load is
  // fault-isolated, degrading to an empty library on failure.
  const promptsPromise = listPrompts().catch(() => []);

  const [projects, sessionRows, layoutJson, terminalsJson] = await Promise.all([
    listProjects(),
    listSessions(),
    loadLayout(LAYOUT_KEY),
    loadLayout(TERMINALS_KEY),
  ]);

  const sessions: Record<string, UiSession> = {};
  let newest: SessionRow | undefined;
  for (const row of sessionRows) {
    const session = idleSession(row);
    sessions[row.id] = session;
    // A put-away session would boot on open, undoing the park or archive.
    if (isPutAway(session)) {
      continue;
    }
    if (!newest || row.createdAt > newest.createdAt) {
      newest = row;
    }
  }

  const layout = parseLayout(layoutJson);
  useSessions.setState((state) => ({
    // Only set which session is active; the pane-mount rule (sessionPaneMounts)
    // makes exactly the active session resume on boot, with every background
    // session dormant until first viewed. Activation policy is not restored
    // here — that lives entirely in the session store.
    activeSessionId: state.activeSessionId ?? newest?.id ?? null,
    projects,
    sessions,
  }));
  if (layout) {
    useLayout.setState({
      layout: pruneSortState(
        layout,
        new Set(projects.map((p) => p.id)),
        new Set(Object.keys(sessions))
      ),
    });
  }

  const terminals = parseTerminals(terminalsJson);
  if (terminals) {
    useTerminals.getState().hydrate(terminals);
  }

  const prompts = await promptsPromise;
  usePromptLibrary.getState().setPrompts(prompts);
}

/**
 * Field/segment separator for {@link persistKey}. A NUL byte cannot occur in any
 * of the joined values (ids, paths, titles, cwds), so two distinct field layouts
 * can never serialize to the same key. A plain space would be unsafe: titles and
 * paths legitimately contain spaces, and a collision silently skips a real persist.
 */
const SEP = "\u0000";

/**
 * A single {@link SessionRow} field value, reduced to a stable string token —
 * the one place {@link rowKey} has to know how to stringify each primitive
 * shape a row field can hold.
 */
function fieldToken(
  value: string | number | boolean | null | undefined
): string {
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value === "boolean") {
    return value ? "1" : "0";
  }
  return String(value);
}

/**
 * Fold a {@link SessionRow} (via {@link sessionRow}) or a {@link ProjectRow}
 * into one fingerprint line, keyed in sorted-field order rather than the
 * object's own insertion order — so a field added to either row later joins
 * {@link persistKey}'s fingerprint automatically, without this function
 * having to be told about it.
 */
function rowKey(row: SessionRow | ProjectRow): string {
  return Object.entries(row)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([, value]) => fieldToken(value))
    .join(SEP);
}

/**
 * A fingerprint of only the fields that are actually persisted: project rows,
 * each session's {@link sessionRow} projection, and the layout. High-frequency
 * churn (events, usage, activity, status/summary, processing) is excluded, so
 * a busy session does not trigger a re-persist of every row on every tick.
 */
export function persistKey(
  state: ReturnType<typeof useSessions.getState>
): string {
  const projects = state.projects.map(rowKey).join("\n");
  const sessions = Object.values(state.sessions)
    .map((s) => rowKey(sessionRow(s)))
    .sort()
    .join("\n");
  return [projects, sessions].join(SEP);
}

function persist(state: ReturnType<typeof useSessions.getState>): void {
  for (const project of state.projects) {
    ignore(upsertProject(project));
  }
  for (const session of Object.values(state.sessions)) {
    ignore(upsertSession(sessionRow(session)));
  }
}

/**
 * Subscribes to the store and persists projects, sessions, and layout on
 * change (debounced). Returns an unsubscribe function.
 */
export function installPersistence(): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;

  const initial = useSessions.getState();
  // Cheap fast-path guard: the only slices carrying persisted data. If none of
  // their references changed, no persisted field could have changed, so we skip
  // without computing a key — this is the hot path under event/usage churn.
  let prevProjects = initial.projects;
  let prevSessions = initial.sessions;
  // Precise guard: catches status/summary-only changes that mutate the sessions
  // reference but touch no persisted field.
  let prevKey = persistKey(initial);

  const unsubscribeSessions = useSessions.subscribe((state) => {
    if (state.projects === prevProjects && state.sessions === prevSessions) {
      return;
    }
    prevProjects = state.projects;
    prevSessions = state.sessions;

    const key = persistKey(state);
    if (key === prevKey) {
      return;
    }
    prevKey = key;

    if (timer !== undefined) {
      clearTimeout(timer);
    }
    timer = setTimeout(() => persist(state), PERSIST_DEBOUNCE_MS);
  });

  // Layout persists on its own store now that it moved out of the session
  // store — same debounce, its own single-field guard.
  let layoutTimer: ReturnType<typeof setTimeout> | undefined;
  let prevLayout = useLayout.getState().layout;
  const unsubscribeLayout = useLayout.subscribe((state) => {
    if (state.layout === prevLayout) {
      return;
    }
    prevLayout = state.layout;
    if (layoutTimer !== undefined) {
      clearTimeout(layoutTimer);
    }
    layoutTimer = setTimeout(
      () => ignore(saveLayout(LAYOUT_KEY, JSON.stringify(prevLayout))),
      PERSIST_DEBOUNCE_MS
    );
  });

  // Project-terminal structure persists on its own store (tabs/panes/layout),
  // keyed separately so it round-trips independently of the window layout.
  let terminalsTimer: ReturnType<typeof setTimeout> | undefined;
  let prevTerminals = useTerminals.getState().byProject;
  const unsubscribeTerminals = useTerminals.subscribe((state) => {
    if (state.byProject === prevTerminals) {
      return;
    }
    prevTerminals = state.byProject;
    if (terminalsTimer !== undefined) {
      clearTimeout(terminalsTimer);
    }
    terminalsTimer = setTimeout(
      () => ignore(saveLayout(TERMINALS_KEY, JSON.stringify(prevTerminals))),
      PERSIST_DEBOUNCE_MS
    );
  });

  return () => {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    if (layoutTimer !== undefined) {
      clearTimeout(layoutTimer);
    }
    if (terminalsTimer !== undefined) {
      clearTimeout(terminalsTimer);
    }
    unsubscribeSessions();
    unsubscribeLayout();
    unsubscribeTerminals();
  };
}
