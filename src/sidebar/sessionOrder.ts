import type {
  HideOlderThan,
  SessionSort,
  SidebarMode,
} from "../state/layout.ts";
import type { UiSession } from "../state/sessions.ts";
import { unseenOutput, type ViewedMarker } from "../state/viewedMarker.ts";
import type { ProjectRow, SessionStatus } from "../types.ts";

const HIDE_HOUR_MS = 3_600_000;
const HIDE_DAY_MS = 24 * HIDE_HOUR_MS;

/** Milliseconds a session may sit stale before a threshold folds it away. */
const HIDE_THRESHOLD_MS: Record<Exclude<HideOlderThan, "off">, number> = {
  "1d": HIDE_DAY_MS,
  "1h": HIDE_HOUR_MS,
  "1w": 7 * HIDE_DAY_MS,
  "3d": 3 * HIDE_DAY_MS,
  "6h": 6 * HIDE_HOUR_MS,
};

/**
 * Triage rank of a session within its project group: what most needs the user
 * floats up. Waiting/errored first, then live work, then idle, then finished.
 * Lower sorts higher. Used only in `triage` mode; `calm` keeps recency order.
 */
export function sessionRank(status: SessionStatus): number {
  switch (status) {
    case "waiting":
      return 0;
    case "error":
      return 1;
    case "running":
      return 2;
    case "idle":
      return 3;
    default:
      return 4; // done
  }
}

/**
 * How urgently a project wants the user, from its open sessions — the key
 * `triage` mode floats projects by. 0: something is blocked (waiting/error);
 * 1: work is running; 2: idle work is open; 3: only finished/nothing. Lower
 * sorts higher.
 */
export function projectUrgency(sessions: UiSession[]): number {
  let best = 3;
  for (const session of sessions) {
    if (session.archivedAt !== null) {
      continue;
    }
    if (session.status === "waiting" || session.status === "error") {
      return 0;
    }
    if (session.status === "running") {
      best = Math.min(best, 1);
    } else if (session.status !== "done") {
      best = Math.min(best, 2);
    }
  }
  return best;
}

/**
 * Order projects by a saved manual arrangement: placed projects follow
 * `manual`'s order; projects not in it (newly opened) sort alphabetically and
 * sit *above* the arranged block, so a new project is visible and the user's
 * arrangement stays put below it. Mirrors how unplaced sessions float on top.
 */
function sortProjectsManual(
  projects: ProjectRow[],
  manual: string[]
): ProjectRow[] {
  const position = new Map(manual.map((id, index) => [id, index]));
  const placed = projects
    .filter((project) => position.has(project.id))
    .sort((a, b) => (position.get(a.id) ?? 0) - (position.get(b.id) ?? 0));
  const unplaced = projects
    .filter((project) => !position.has(project.id))
    .sort((a, b) => a.name.localeCompare(b.name));
  return [...unplaced, ...placed];
}

/**
 * Order the sidebar's project groups. A non-empty `manualProjectOrder` wins in
 * every mode — the user's drag arrangement *is* the order (see
 * {@link sortProjectsManual}). With no manual order, `calm` keeps the
 * predictable alphabetical list and `triage` floats projects that need
 * attention to the top, falling back to alphabetical within an equal urgency
 * (Array.sort is stable).
 */
export function sortProjects(
  projects: ProjectRow[],
  sessionsByProject: Map<string, UiSession[]>,
  mode: SidebarMode,
  manualProjectOrder: string[]
): ProjectRow[] {
  if (manualProjectOrder.length > 0) {
    return sortProjectsManual(projects, manualProjectOrder);
  }
  const byName = [...projects].sort((a, b) => a.name.localeCompare(b.name));
  if (mode === "calm") {
    return byName;
  }
  return byName.sort(
    (a, b) =>
      projectUrgency(sessionsByProject.get(a.id) ?? []) -
      projectUrgency(sessionsByProject.get(b.id) ?? [])
  );
}

/** A session row's mode- and unseen-derived presentation policy (no theme). */
export interface SessionRowView {
  /** A finished session carrying output the user has not seen. Drives the ✓
   *  color and title ink regardless of mode. */
  doneUnseen: boolean;
  /** Show the live context line (tools/agents). Hidden on finished rows, where
   *  the ✓ already carries the state, and on idle rows — parked work is a
   *  single quiet line (design 5a), not a title with an "Idle" subtitle. */
  showContext: boolean;
  /** Show the "new" pill. Follows the sidebar mode, not the (filter-forced)
   *  list ordering: an unread finish, in triage. Calm never badges. */
  showNewBadge: boolean;
}

/**
 * Derive one session row's presentation policy from its status, unseen count,
 * and the sidebar mode. The single place the "unread finish → badge in triage"
 * and "no context on a finished row" rules live, so `SessionRow` renders them
 * instead of re-deciding inline. `mode` is the sidebar mode (the badge is a
 * triage affordance); ordering uses its own filter-forced list mode separately.
 */
export function sessionRowView(
  status: SessionStatus,
  unseen: number,
  mode: SidebarMode
): SessionRowView {
  const doneUnseen = status === "done" && unseen > 0;
  return {
    doneUnseen,
    showContext: status !== "done" && status !== "idle",
    showNewBadge: mode === "triage" && doneUnseen,
  };
}

/**
 * Priority tier for {@link pickFocusSession}: a session waiting on the user
 * sorts first (it needs input), running work second, everything else last.
 * Lower sorts higher — mirrors {@link sessionRank} but collapses idle/error/done
 * into one tier since the focus pick only cares about "needs you" vs. not.
 */
function focusPriority(status: SessionStatus): number {
  switch (status) {
    case "waiting":
      return 0;
    case "running":
      return 1;
    default:
      return 2;
  }
}

/**
 * Pick the session a project's Focus rail should jump to: a session waiting on
 * the user, else running, else the most recently active by `lastChangeMs`
 * (falling back to `createdAt` when a session has no recorded change), else —
 * with every candidate equally silent — the newest. `undefined` for an empty
 * list.
 */
export function pickFocusSession(
  sessions: UiSession[],
  lastChangeMs: Record<string, number>
): UiSession | undefined {
  return [...sessions].sort((a, b) => {
    const priority = focusPriority(a.status) - focusPriority(b.status);
    if (priority !== 0) {
      return priority;
    }
    const aChange = lastChangeMs[a.id] ?? a.createdAt;
    const bChange = lastChangeMs[b.id] ?? b.createdAt;
    if (bChange !== aChange) {
      return bChange - aChange;
    }
    return b.createdAt - a.createdAt;
  })[0];
}

/** A project group's session ids split into rendered rows and hidden Done. */
export interface OrderedSessions {
  /** Read (seen) Done ids folded behind the "N done" summary; `triage` only. */
  collapsedDone: string[];
  /** Stale ids folded behind the "N older" summary; empty when hiding is off. */
  collapsedOld: string[];
  /** Session ids rendered as full rows, in display order. */
  rows: string[];
}

/** A project's ordered rows as the sidebar draws them: {@link OrderedSessions}
 *  with each [Nested session] placed under its lead session, and how deep it
 *  sits there. */
export interface MatchedSessions extends OrderedSessions {
  /** Depth under its lead session for each row {@link nestRows} placed under
   *  one; absent means top level. The row's indent reads this, so a row is
   *  drawn nested exactly when it was placed nested. */
  nestDepth: Record<string, number>;
}

/** Stable empty manual order — callers pass this when a project has none, so
 *  the memo cache's identity guard sees one unchanged value. */
export const EMPTY_ORDER: string[] = [];

/** Order a list by one sort mode. `manual` keeps unlisted (new) sessions on
 *  top, newest first, above the user's arranged block; stale ids are ignored. */
function sortBy(
  sessions: UiSession[],
  sort: SessionSort,
  manual: string[]
): UiSession[] {
  const newestFirst = (a: UiSession, b: UiSession) => b.createdAt - a.createdAt;
  if (sort === "name") {
    return [...sessions].sort(
      (a, b) => a.title.localeCompare(b.title) || newestFirst(a, b)
    );
  }
  if (sort === "manual") {
    const position = new Map(manual.map((id, index) => [id, index]));
    const placed = sessions
      .filter((s) => position.has(s.id))
      .sort((a, b) => (position.get(a.id) ?? 0) - (position.get(b.id) ?? 0));
    const unplaced = sessions
      .filter((s) => !position.has(s.id))
      .sort(newestFirst);
    return [...unplaced, ...placed];
  }
  return [...sessions].sort(newestFirst);
}

/**
 * Order one project's open sessions for a mode and sort. `calm` shows every
 * session per `sort` (newest-first for `date`, the current structure just
 * recolored). `triage` folds read Done into {@link OrderedSessions.collapsedDone}
 * regardless of sort, and — for the default `date` sort only — floats
 * blocked/live/idle work up by {@link sessionRank}; an explicit `name` or
 * `manual` sort fully wins over status floating (a drop or a name sort stays
 * exactly where it put things).
 */
export function orderSessions(
  sessions: UiSession[],
  unseen: (id: string) => number,
  mode: SidebarMode,
  sort: SessionSort,
  manual: string[]
): OrderedSessions {
  const open = sessions.filter((session) => session.archivedAt === null);

  if (mode === "calm") {
    return {
      collapsedDone: [],
      collapsedOld: [],
      rows: sortBy(open, sort, manual).map((session) => session.id),
    };
  }

  // Triage always folds read Done away; folding is collapsing, not ordering.
  const active: UiSession[] = [];
  const readDone: UiSession[] = [];
  for (const session of open) {
    if (session.status === "done" && unseen(session.id) === 0) {
      readDone.push(session);
    } else {
      active.push(session);
    }
  }
  const sorted = sortBy(active, sort, manual);
  return {
    collapsedDone: sortBy(readDone, "date", EMPTY_ORDER).map((s) => s.id),
    collapsedOld: [],
    // Status floating is the *default* triage ordering; an explicit manual or
    // name sort fully wins (design: a drop stays exactly where you put it).
    rows: (sort === "date"
      ? sorted.sort((a, b) => sessionRank(a.status) - sessionRank(b.status))
      : sorted
    ).map((session) => session.id),
  };
}

/**
 * The manual order a drop produces: `activeId` moved to `overId`'s position
 * within the visible rows, merged with the previously saved order (`prev`) so
 * a drop never erases placements it can't see. An id in `prev` that isn't
 * visible right now (archived, or a Done row folded away in triage) keeps its
 * slot — re-inserted after its nearest surviving predecessor from `prev`, or
 * at the top when it led the list. Folded Done ids the user never placed are
 * appended, so a later mode switch cannot mistake them for "new" (unlisted
 * floats to the top). Null when the drop is a no-op.
 */
export function dropOrder(
  prev: string[],
  rows: string[],
  collapsedDone: string[],
  activeId: string,
  overId: string | null
): string[] | null {
  if (overId === null || activeId === overId) {
    return null;
  }
  const from = rows.indexOf(activeId);
  const to = rows.indexOf(overId);
  if (from === -1 || to === -1) {
    return null;
  }
  const result = [...rows];
  result.splice(from, 1);
  result.splice(to, 0, activeId);
  // Weave the saved-but-hidden ids back into place. Quadratic in list length,
  // but a project group holds tens of sessions, not thousands.
  for (const [index, id] of prev.entries()) {
    if (result.includes(id)) {
      continue;
    }
    let insertAt = 0;
    for (let i = index - 1; i >= 0; i -= 1) {
      const at = result.indexOf(prev[i] ?? "");
      if (at !== -1) {
        insertAt = at + 1;
        break;
      }
    }
    result.splice(insertAt, 0, id);
  }
  for (const id of collapsedDone) {
    if (!result.includes(id)) {
      result.push(id);
    }
  }
  return result;
}

/** The session-store slices {@link orderMatched} reads. */
export interface OrderInputs {
  appendSeq: Record<string, number>;
  sessions: Record<string, UiSession>;
  /**
   * Where each session's status came from. A launch replay is not unseen
   * output — see {@link unseenOutput}.
   */
  statusOrigin: Record<string, "seeded" | "live">;
  viewed: Record<string, ViewedMarker>;
}

/** The cross-store inputs the staleness fold needs, passed into orderMatched. */
export interface HideInputs {
  activeSessionId: string | null;
  lastChangeMs: Record<string, number>;
  now: number;
  threshold: HideOlderThan;
}

/** A row list split into the rows still shown and the stale ids folded away. */
export interface PartitionedRows {
  collapsedOld: string[];
  rows: string[];
}

/**
 * Fold stale sessions out of an ordered row list. A row folds only when it is
 * neither the active session nor live/awaited work: idle, or a finished row the
 * user has already seen, whose last activity ({@link lastChangeMs}, falling back
 * to `createdAt`) predates the threshold's cutoff from `now`. `off` folds
 * nothing (identity). Running/waiting/error and unread-done are always kept —
 * age never buries live or unseen work. Order within each side is preserved.
 */
export function partitionOld(
  rows: string[],
  sessions: Record<string, UiSession>,
  lastChangeMs: Record<string, number>,
  unseen: (id: string) => number,
  activeSessionId: string | null,
  threshold: HideOlderThan,
  now: number
): PartitionedRows {
  if (threshold === "off") {
    return { collapsedOld: EMPTY_ORDER, rows };
  }
  const cutoff = now - HIDE_THRESHOLD_MS[threshold];
  const kept: string[] = [];
  const old: string[] = [];
  for (const id of rows) {
    const session = sessions[id];
    const eligible =
      session !== undefined &&
      id !== activeSessionId &&
      (session.status === "idle" ||
        (session.status === "done" && unseen(id) === 0));
    const lastActive = lastChangeMs[id] ?? session?.createdAt ?? now;
    if (eligible && lastActive < cutoff) {
      old.push(id);
    } else {
      kept.push(id);
    }
  }
  return { collapsedOld: old, rows: kept };
}

/** The unseen-output counter for one {@link OrderInputs} generation. */
function unseenFrom(input: OrderInputs): (id: string) => number {
  return (id: string) =>
    unseenOutput({
      appendSeq: input.appendSeq[id] ?? 0,
      marker: input.viewed[id],
      origin: input.statusOrigin[id],
    });
}

/**
 * Projects whose every open session has folded away as stale — the whole-group
 * form of {@link partitionOld}, and the list the sidebar hides behind its
 * "N inactive projects" fold. One threshold drives both: a project disappears
 * only once nothing inside it wants the user, so the exemptions that keep a
 * one row visible (the active session, running/waiting/error work, an unread
 * finish) each keep the whole group visible too.
 *
 * Archived-only projects are left out: they have already left the rail on
 * their own, and listing them would inflate the fold's count with groups
 * nobody can see. `off` hides nothing.
 */
export function inactiveProjectIds(
  input: OrderInputs,
  hide: HideInputs
): string[] {
  if (hide.threshold === "off") {
    return EMPTY_ORDER;
  }
  const byProject = new Map<string, string[]>();
  for (const session of Object.values(input.sessions)) {
    if (session.archivedAt !== null) {
      continue;
    }
    const bucket = byProject.get(session.projectId);
    if (bucket) {
      bucket.push(session.id);
    } else {
      byProject.set(session.projectId, [session.id]);
    }
  }
  const unseen = unseenFrom(input);
  const inactive: string[] = [];
  for (const [projectId, ids] of byProject) {
    const { rows } = partitionOld(
      ids,
      input.sessions,
      hide.lastChangeMs,
      unseen,
      hide.activeSessionId,
      hide.threshold,
      hide.now
    );
    if (rows.length === 0) {
      inactive.push(projectId);
    }
  }
  // Sorted so an unchanged set of projects yields an equal array every pass —
  // the sidebar's selector compares it shallowly.
  return inactive.sort((a, b) => (a < b ? -1 : 1));
}

function computeMatched(
  input: OrderInputs,
  project: ProjectRow,
  filter: string,
  nameMatch: boolean,
  mode: SidebarMode,
  sort: SessionSort,
  manual: string[],
  hide: HideInputs
): MatchedSessions {
  const list = Object.values(input.sessions).filter(
    (session) =>
      session.projectId === project.id &&
      session.archivedAt === null &&
      (filter === "" ||
        nameMatch ||
        session.title.toLowerCase().includes(filter))
  );
  const unseen = unseenFrom(input);
  const ordered = orderSessions(list, unseen, mode, sort, manual);
  const { collapsedOld, rows } = partitionOld(
    ordered.rows,
    input.sessions,
    hide.lastChangeMs,
    unseen,
    hide.activeSessionId,
    hide.threshold,
    hide.now
  );
  const nested = nestRows(rows, input.sessions);
  return {
    collapsedDone: ordered.collapsedDone,
    collapsedOld,
    nestDepth: nested.depth,
    rows: nested.rows,
  };
}

/** No row nested: one shared object, so the memo's result stays stable. */
const NO_NESTING: Record<string, number> = {};

/**
 * `rows` with every [Nested session] moved to just under the session it was
 * started from, its own nested ones under it, in their listed order, and the
 * depth each moved row sits at. One whose lead session isn't listed (closed,
 * folded, filtered out, another project) keeps its place at the top level.
 * The same array back when nothing moves.
 */
export function nestRows(
  rows: string[],
  sessions: Record<string, UiSession>
): { depth: Record<string, number>; rows: string[] } {
  const listed = new Set(rows);
  const children = new Map<string, string[]>();
  for (const id of rows) {
    const lead = sessions[id]?.nestedUnder;
    if (lead && lead !== id && listed.has(lead)) {
      children.set(lead, [...(children.get(lead) ?? []), id]);
    }
  }
  if (children.size === 0) {
    return { depth: NO_NESTING, rows };
  }
  const nestedIds = new Set([...children.values()].flat());
  const out: string[] = [];
  const depth: Record<string, number> = {};
  const placed = new Set<string>();
  const place = (id: string, level: number) => {
    if (placed.has(id)) {
      return;
    }
    placed.add(id);
    out.push(id);
    if (level > 0) {
      depth[id] = level;
    }
    for (const child of children.get(id) ?? []) {
      place(child, level + 1);
    }
  };
  for (const id of rows) {
    if (!nestedIds.has(id)) {
      place(id, 0);
    }
  }
  // A cycle (a under b under a) has no top: list what's left as it came.
  for (const id of rows) {
    place(id, 0);
  }
  return { depth, rows: out };
}

interface OrderCacheEntry {
  appendSeq: Record<string, number>;
  lastChangeMs: Record<string, number>;
  manual: string[];
  result: MatchedSessions;
  statusOrigin: Record<string, "seeded" | "live">;
  viewed: Record<string, ViewedMarker>;
}

/**
 * Keyed on the `sessions` map identity (WeakMap), then per
 * `project·filter·nameMatch·mode`, with each entry additionally guarded on the
 * `viewed` and `appendSeq` identities. Per-key storage is the point: the old
 * single module-global slot in `ProjectGroup` was shared by every project, so
 * two groups rendering in one pass overwrote each other's entry and both re-ran
 * the scan+sort every store update. Keyed, each project reuses its own result
 * until one of its inputs actually moves. The WeakMap drops a whole `sessions`
 * generation's entries when the store replaces the map, so it can't leak.
 */
const orderCache = new WeakMap<
  Record<string, UiSession>,
  Map<string, OrderCacheEntry>
>();

/**
 * A project's open, filter-matched sessions ordered for the current mode and
 * sort ({@link orderSessions}), memoized so the `rows` and `collapsedDone`
 * selectors — and repeat renders with unchanged inputs — reuse one scan+sort
 * instead of walking every session again. Guarded on every input it reads, so
 * a stale entry can only cause a recompute, never a wrong result. `manual` is
 * the project's saved id list ({@link EMPTY_ORDER} when it has none).
 */
export function orderMatched(
  input: OrderInputs,
  project: ProjectRow,
  filter: string,
  nameMatch: boolean,
  mode: SidebarMode,
  sort: SessionSort,
  manual: string[],
  hide: HideInputs
): MatchedSessions {
  let byKey = orderCache.get(input.sessions);
  if (!byKey) {
    byKey = new Map<string, OrderCacheEntry>();
    orderCache.set(input.sessions, byKey);
  }
  // JSON-encode the key: both `project.id` (which can be a filesystem path with
  // spaces) and `filter` (user text) are variable-length, so a plain join could
  // let two distinct tuples collide on one key and return the wrong project's
  // ordering. Quoted/escaped strings can't collide.
  const key = JSON.stringify([
    project.id,
    nameMatch,
    mode,
    filter,
    sort,
    hide.threshold,
    hide.now,
    hide.activeSessionId,
  ]);
  const cached = byKey.get(key);
  if (
    cached &&
    cached.viewed === input.viewed &&
    cached.appendSeq === input.appendSeq &&
    cached.manual === manual &&
    cached.lastChangeMs === hide.lastChangeMs &&
    cached.statusOrigin === input.statusOrigin
  ) {
    return cached.result;
  }
  const result = computeMatched(
    input,
    project,
    filter,
    nameMatch,
    mode,
    sort,
    manual,
    hide
  );
  byKey.set(key, {
    appendSeq: input.appendSeq,
    lastChangeMs: hide.lastChangeMs,
    manual,
    result,
    statusOrigin: input.statusOrigin,
    viewed: input.viewed,
  });
  return result;
}
