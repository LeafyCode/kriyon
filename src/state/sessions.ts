import { create } from "zustand";
import type {
  ResourcesUpdate,
  SleepPhase,
  StoredSleepPhase,
} from "../ipc/bridge.ts";
import { upsertSession } from "../ipc/bridge.ts";
import type {
  HooksOffScope,
  NestedReport,
  ProjectRow,
  SessionActivity,
  SessionRow,
  SessionStatus,
  StudioEvent,
  ToolActivity,
  UsageSnapshot,
} from "../types.ts";
import { type BootEvent, type BootPhase, nextBootPhase } from "./bootPhase.ts";
// The [Changes refresh coordinator] reads this store and this store triggers
// it back — see `changesRefresh.ts`'s module doc and ADR-0020 for why that
// cycle is deliberate and inert. Suppressed per-import rather than file-wide,
// so a *new* cycle in this file is still a lint error.
// biome-ignore lint/suspicious/noImportCycles: deliberate and inert — see above.
import { useChanges } from "./changes.ts";
import {
  forgetSessionRefresh,
  refreshOnBaselineLanded,
  requestRefresh,
  // biome-ignore lint/suspicious/noImportCycles: deliberate and inert — see above.
} from "./changesRefresh.ts";
import { useUsageCards } from "./usageCards.ts";
import {
  completedTasks,
  stampViewed,
  type ViewedMarker,
} from "./viewedMarker.ts";
import { nextWarmPanes } from "./warmPanes.ts";

/** Cap on retained transcript events per session, to bound memory growth. */
const MAX_EVENTS = 1000;

/** Swallow a fire-and-forget IPC write's rejection — the persistence layer's
 * idiom (see `actions.ts`/`persistence.ts`): a best-effort backend write must
 * never surface as an unhandled rejection. */
function ignore(promise: Promise<unknown>): void {
  promise.catch(() => {
    // Intentionally empty: best-effort write, caller degrades gracefully.
  });
}

/**
 * Per-array index of the event ids it holds, keyed by the array's identity.
 * Lets {@link SessionsState.appendEvent} dedupe a re-seen id in O(1) instead of
 * scanning the whole capped buffer every line. Keyed weakly by the events
 * array, so it rebuilds automatically if the array is replaced out of band
 * (e.g. a test reset) and is collected when the array is dropped.
 */
const seenEventIds = new WeakMap<StudioEvent[], Set<string>>();

/** The seen-id set for an events array, built once on first use then carried forward. */
function seenIdsFor(events: StudioEvent[] | undefined): Set<string> {
  if (!events) {
    return new Set();
  }
  const cached = seenEventIds.get(events);
  if (cached) {
    return cached;
  }
  const built = new Set(events.map((e) => e.id));
  seenEventIds.set(events, built);
  return built;
}

/**
 * Bound the buffer to {@link MAX_EVENTS}, evicting the dropped ids from `seen`
 * so it keeps mirroring exactly the retained array.
 */
function capEvents(next: StudioEvent[], seen: Set<string>): StudioEvent[] {
  if (next.length <= MAX_EVENTS) {
    return next;
  }
  const drop = next.length - MAX_EVENTS;
  for (let i = 0; i < drop; i += 1) {
    seen.delete(next[i]?.id ?? "");
  }
  return next.slice(drop);
}

export interface UiSession {
  /** When the session was archived (ms since epoch), or null while active. */
  archivedAt: number | null;
  /**
   * The git oid captured at session start (see `captureBaseline`), used as the
   * base of the working-tree diff for the Changes view. `null` until a
   * baseline has been captured, or when the session's cwd is not a git repo.
   * Mirrors {@link SessionRow.baselineOid} — carried through so `persist()`
   * can round-trip it instead of clobbering it with `null` on every sweep.
   */
  baselineOid: string | null;
  claudeSessionId: string | null;
  createdAt: number;
  cwd: string;
  id: string;
  /** The session this [Nested session] was started from (see
   *  {@link SessionRow.nestedUnder}). */
  nestedUnder?: string | null;
  /** The [Handoff link] (see {@link SessionRow.parentSessionId}). */
  parentSessionId?: string | null;
  projectId: string;
  status: SessionStatus;
  summary: string;
  title: string;
  /** The user renamed this session by hand; auto-titles must not overwrite it. */
  titleLocked: boolean;
  worktreePath: string | null;
}

/**
 * Build a fresh, idle {@link UiSession} from a persisted session row. The single
 * row→UiSession factory, shared by session creation and hydration so both
 * produce an identical shape.
 */
export function idleSession(row: SessionRow): UiSession {
  return { ...row, status: "idle", summary: "" };
}

/**
 * Project a {@link UiSession} down to its persisted {@link SessionRow} —
 * {@link idleSession}'s inverse, and the single UiSession→row projection.
 * Feeds every place that writes a session row to the backend
 * (`setBaseline`, `persistence.ts`'s `persist`) and the persisted-fields
 * fingerprint (`persistence.ts`'s `persistKey`, which folds this
 * projection's own entries), so a new persisted field is added here once and
 * automatically reaches all three instead of drifting across hand-written
 * literals. Runtime-only fields (`status`, `summary`) are dropped, exactly
 * the fields `idleSession` fills back in on the way in.
 */
export function sessionRow(session: UiSession): SessionRow {
  return {
    archivedAt: session.archivedAt,
    baselineOid: session.baselineOid,
    claudeSessionId: session.claudeSessionId,
    createdAt: session.createdAt,
    cwd: session.cwd,
    id: session.id,
    nestedUnder: session.nestedUnder ?? null,
    parentSessionId: session.parentSessionId ?? null,
    projectId: session.projectId,
    title: session.title,
    titleLocked: session.titleLocked,
    worktreePath: session.worktreePath,
  };
}

/**
 * Whether a [Session] runs in its own [Worktree]. The single predicate behind
 * every "is this a worktree session?" check — the sidebar chip, the per-project
 * `⎇N` count, the dirty dot, and the working-dir choice all read it, so the
 * null-vs-empty sentinel can never be judged two ways in two places. An unset
 * `worktreePath` (null *or* ""), means the session runs in the project folder.
 */
export function isWorktreeSession(session: UiSession | undefined): boolean {
  const path = session?.worktreePath;
  return path !== null && path !== undefined && path !== "";
}

/**
 * The working directory a [Session] occupies: its [Worktree] when it runs in
 * one, else its `cwd` (the project folder). The one place that precedence
 * lives — collision detection, repo-status polling, and the composer's cwd all
 * derive from it. `""` for an absent session.
 */
export function sessionWorkingDir(session: UiSession | undefined): string {
  if (!session) {
    return "";
  }
  return isWorktreeSession(session)
    ? (session.worktreePath as string)
    : session.cwd;
}

/**
 * The branch-shaped label for a worktree [Session] — the last segment of its
 * [Worktree] path (the sanitized branch dir) — or null when the session runs
 * in the project folder. Drives the sidebar row's worktree mark beside the
 * title and the branch name on its meta line.
 */
export function worktreeName(session: UiSession | undefined): string | null {
  if (!isWorktreeSession(session)) {
    return null;
  }
  return (
    (session as UiSession).worktreePath?.split("/").filter(Boolean).pop() ??
    null
  );
}

export interface SessionsState {
  activeSessionId: string | null;
  activity: Record<string, SessionActivity>;
  addProject: (p: ProjectRow) => void;
  addSession: (s: UiSession) => void;
  appendEvent: (sessionId: string, event: StudioEvent) => void;
  /** Apply a burst of transcript events in one store update (one render). */
  appendEvents: (sessionId: string, incoming: StudioEvent[]) => void;
  /**
   * Events ever appended per session — monotonic, unlike `events[id].length`,
   * which pins at the ring's cap. "Unseen output" checks compare this against
   * the {@link ViewedMarker}'s `appendSeq` (see {@link SessionsState.viewed}).
   */
  appendSeq: Record<string, number>;
  applyActivity: (id: string, snapshot: SessionActivity) => void;
  /**
   * Advance a session's [Boot phase] by one {@link BootEvent} through the pure
   * {@link nextBootPhase} reducer. The single writer of `bootPhase`, so every
   * transition goes through one place (the coordinator owns the safety-net
   * timer; see `beginBoot`/`sessionBecameLive` in actions).
   */
  applyBootEvent: (id: string, event: BootEvent) => void;
  applyClaudeId: (id: string, claudeSessionId: string) => void;
  applyHooksOff: (sessionId: string, scope: HooksOffScope | null) => void;
  applyResources: (update: ResourcesUpdate) => void;
  applySleeping: (sessionId: string, state: SleepPhase) => void;
  applyStatus: (
    id: string,
    status: SessionStatus,
    summary: string,
    seeded?: boolean
  ) => void;
  applyTitle: (id: string, title: string) => void;
  applyUsage: (id: string, snapshot: UsageSnapshot) => void;
  archiveSession: (id: string) => void;
  /** Each session's [Boot phase]; absent ⇒ `idle`. */
  bootPhase: Record<string, BootPhase>;
  clearEvents: (sessionId: string) => void;
  /** Reads and removes a [Nested session]'s report address (one-shot at launch). */
  consumePendingReport: (id: string) => NestedReport | undefined;
  /** Reads and removes a session's seed prompt, if any (one-shot at launch). */
  consumePendingSeedPrompt: (id: string) => string | undefined;
  /**
   * Latest CPU percent (of one core) per session id, replaced wholesale by
   * each `session-resources` sweep. A session is absent until the sampler has
   * two samples to diff.
   */
  cpu: Record<string, number>;
  events: Record<string, StudioEvent[]>;
  /**
   * Sessions whose `claude` died underneath the app — the daemon or shell
   * exited without a closing hook, so the last `status` is frozen mid-turn.
   * Set by the session host's exit signal, cleared by the next live hook
   * (only a running `claude` can produce one). Ephemeral, never persisted.
   */
  exited: Record<string, boolean>;
  /**
   * [Hooks off]: id → the settings scope that stops Kriyon's hooks for the
   * session. Absent means they run. While present, the session's status and
   * usage can't be known, and the UI says so instead of showing "idle".
   */
  hooksOff: Record<string, HooksOffScope>;
  /**
   * Latest [Session footprint] per session id (MB), replaced wholesale by
   * each `session-resources` sweep. The sweep's whole-app total is not kept
   * here — no sidebar surface renders it (the tray reads its own snapshot).
   */
  memory: Record<string, number>;
  /**
   * Record that a session's `claude` exited underneath the app. Ignores ids the
   * store does not know (the host's exit signal is shared with Project terminal
   * panes). See {@link SessionsState.exited}.
   */
  noteSessionExited: (id: string) => void;
  /** Put a project away: stamp `parkedAt`, and move the selection and warm
   *  panes off its sessions. Stopping them is `parkProjectAndStop`'s job. */
  parkProject: (projectId: string) => void;
  /** Where each [Nested session] not yet launched reports its first answer. */
  pendingReport: Record<string, NestedReport>;
  /** In-memory seed prompts for follow-up sessions, consumed at first launch. Never persisted. */
  pendingSeedPrompt: Record<string, string>;
  projects: ProjectRow[];
  removeSession: (id: string) => void;
  /** Rename a project by hand. Persists via the project row's `name`. */
  renameProject: (projectId: string, name: string) => void;
  /** Rename a session by hand and lock its title so a later `ai-title` update
   *  cannot overwrite the user's name (see {@link UiSession.titleLocked}). */
  renameSession: (id: string, title: string) => void;
  /**
   * Each session's git repo toplevel (absolute path, from the bridge's
   * `repoToplevel` — `git rev-parse --show-toplevel`), cached the moment the
   * [Changes refresh coordinator]'s `ensureRepoToplevel` resolves it, so
   * `touchedFiles`' absolute paths can be relativized against it without a
   * bridge call per file or per render. Absent until that session's first
   * refresh resolves it. For a worktree session this is the worktree's own
   * root — the coordinator resolves it from {@link sessionWorkingDir}, the
   * same cwd the diff itself is computed against, never the project root.
   */
  repoToplevel: Record<string, string>;
  /**
   * The cwd the coordinator's `ensureRepoToplevel` (see
   * `changesRefresh.ts`) last claimed for a given session — an internal
   * fetch guard, not a value any UI reads directly. Distinct
   * from {@link repoToplevel} itself (the *resolved* toplevel) so the guard
   * can be set synchronously, before the bridge call's promise settles:
   * without it, several `ensureRepoToplevel` calls landing before the first
   * one resolves (mount + a live-edit debounce racing it, say) would each
   * see no cached toplevel yet and all spawn their own `repo_toplevel`.
   * Stays claimed for a session even if that cwd's fetch fails — a session
   * in a non-git directory would otherwise re-spawn `repo_toplevel` on
   * every live-edit refresh forever, one extra process per debounce tick
   * (this app has prior form on spawn cascades). The badge/filter simply
   * stay empty for that session (fails safe) until its cwd actually
   * changes, which claims the guard fresh for the new cwd and allows one
   * more attempt.
   */
  repoToplevelCwd: Record<string, string>;
  sessions: Record<string, UiSession>;
  setActiveSession: (id: string) => void;
  /**
   * Record a session's captured git baseline oid (see `bridge.captureBaseline`)
   * and re-persist the row so it survives app restart. A no-op if the session
   * has since been removed — the fire-and-forget capture in `createSession`
   * can resolve after the session is gone (e.g. immediately archived/closed).
   *
   * `oid: null` clears a baseline that's stopped resolving — the
   * `onBaselineInvalid` callback `refreshSessionChanges` threads into
   * `useChanges().refresh` calls this when `diffSessionChanges` reports the
   * oid as pruned (I1, round-two review), so the *next* refresh degrades to
   * `diffWorkingTree` up front instead of retrying a dead oid and hitting
   * the same failure forever. Deliberately does NOT re-capture a fresh
   * baseline here: doing so would snapshot the CURRENT working tree as the
   * new anchor, silently erasing everything that happened between session
   * start and now from the Changes view — a much bigger surprise than the
   * already-documented (ADR 0015) `baselineOid: null` degradation to the
   * legacy whole-working-tree diff.
   */
  setBaseline: (id: string, oid: string | null) => void;
  setPendingReport: (id: string, report: NestedReport) => void;
  setPendingSeedPrompt: (id: string, text: string) => void;
  /** Sets a project's identity color; null returns it to the automatic hue. */
  setProjectColor: (projectId: string, color: string | null) => void;
  /**
   * Record what the [Changes refresh coordinator]'s `ensureRepoToplevel`
   * learned about `id`'s repo, in the two calls that lookup makes — both
   * through this store rather than a bare `setState` from the coordinator:
   *
   * - **`toplevel` omitted — the claim.** Writes {@link repoToplevelCwd} only,
   *   synchronously, *before* the bridge call, so concurrent callers can't
   *   each spawn a `repo_toplevel`. A failed lookup deliberately leaves the
   *   claim standing (see {@link repoToplevelCwd}) rather than clearing it for
   *   a retry.
   * - **`toplevel` given — the resolve.** Writes {@link repoToplevel} only,
   *   and deliberately does *not* re-claim `cwd`: a claim is monotonic per
   *   session, so a late resolve for a cwd the session has already moved off
   *   must not revert the newer claim — that would let the next
   *   `ensureRepoToplevel` call spend a second `repo_toplevel` *and* a second
   *   `watchWorkingTree` on a directory already being watched.
   *
   * (A stale resolve still lands its `repoToplevel` value, exactly as the code
   * this action replaced did. Dropping it when `repoToplevelCwd[id] !== cwd`
   * would be tighter still — the value is for a directory the session has
   * left — but it is a behavior change, not a refactor, so it is deliberately
   * not made here.)
   */
  setRepoToplevel: (id: string, cwd: string, toplevel?: string) => void;
  /**
   * [Sleeping session]s: id → the phase while Kriyon has its `claude` stopped.
   * Absent means awake. `stuck` means the resume kept failing, so the row must
   * say so rather than looking like an ordinary sleeping session.
   */
  sleeping: Record<string, StoredSleepPhase>;
  /**
   * Where each session's current status came from: `"seeded"` (the backend
   * reconstructed it by replaying the events file at launch) or `"live"` (it
   * was observed while Kriyon was running). Absent until the first update.
   *
   * This is what stops a boot from flooding Needs-you: `viewed` is in-memory
   * only, while the transcript is re-tailed from offset 0 on every launch, so
   * `appendSeq` climbs back to hundreds against a missing marker and
   * `unseenCount` reports every replayed event as unseen output. Every session
   * that seeded to `done` would then read as "finished, unreviewed" — output
   * the user in fact reviewed days ago. The Rust runtime already refuses to
   * relight its badge from a history seed (`SessionRuntime`); the sidebar
   * re-derives the same question in the frontend and needs the same guard.
   *
   * Recording `"live"` rather than just clearing the mark is what makes this
   * ordering-proof: the seed runs on its own thread, so a seeded update can
   * land *after* a live one, and a clear-on-live scheme would let the late
   * seed re-suppress a finish that genuinely happened this run.
   */
  statusOrigin: Record<string, "seeded" | "live">;
  /**
   * Files a session has touched via a Claude-driven `Edit`/`Write`/
   * `MultiEdit`/`NotebookEdit` `PostToolUse`, ordered by first touch and
   * deduped — inferred from `session-activity` transitions (see
   * `completedEditTarget`; there is no raw hook-event stream on the
   * frontend). Feeds the FileTreePane "this session touched" grouping and
   * the Phase 2 changed-files chip. Best-effort like the rest of the
   * hook-event pipeline: a tool completing inside the same 300ms poll tick
   * as it started can be missed (see `crates/kriyon-core/src/watcher.rs`'s
   * `POLL_INTERVAL`) — the Changes view's own `git diff` is still the source
   * of truth for *what* changed, this only drives attribution and the
   * live-refresh trigger.
   */
  touchedFiles: Record<string, string[]>;
  unarchiveSession: (id: string) => void;
  /** Bring a [Parked project] back to the rail. Starts nothing. */
  unparkProject: (projectId: string) => void;
  usage: Record<string, UsageSnapshot>;
  /**
   * The {@link ViewedMarker} per session — what the user had seen when they last
   * left it (in-memory; resets on reload). Stamped at activation; queried by the
   * Catch-up brief and the Needs-you section for unseen counts / windows.
   */
  viewed: Record<string, ViewedMarker>;
  /**
   * The [Warm pane] list — sessions kept mounted besides the active tab so
   * returning never remounts and blanks the terminal — most-recently-left
   * first, bounded to `MAX_WARM_PANES` (LRU). The active session is always
   * mounted without an entry here (see {@link sessionPaneMounts}), so no writer
   * has to remember the "active ⇒ mounted" rule: `setActiveSession` is the sole
   * writer via {@link nextWarmPanes}. On boot nothing is warm, so only the
   * restored active session resumes `claude`. Runtime-only (never persisted).
   */
  warmPanes: string[];
  /**
   * Keep a session's pane mounted without showing it — a [Nested session]
   * started in the background — so its terminal and watch run as a [Warm
   * pane]'s do. The active session is unchanged.
   */
  warmSession: (id: string) => void;
}

/**
 * The sidebar badge count for a session: running subagents plus best-effort-
 * running background shells — the work worth noticing at a glance. Tasks are
 * excluded (a session almost always has one in-progress task while working).
 */
export function badgeCount(activity: SessionActivity | undefined): number {
  if (!activity) {
    return 0;
  }
  const agents = activity.subagents.filter((a) => a.state === "running").length;
  const shells = activity.shells.filter((s) => s.status === "running").length;
  return agents + shells;
}

/** Picks the most-recently-created session id, or null if there are none. */
/**
 * Ids of every [Parked project]. A Set so {@link isPutAway} answers in one
 * lookup inside per-session loops.
 */
export function parkedProjectIds(
  projects: readonly ProjectRow[]
): ReadonlySet<string> {
  return new Set(projects.filter((p) => p.parkedAt !== null).map((p) => p.id));
}

/**
 * Whether a session is put away: an [Archived session], or one in a [Parked
 * project]. Both are stopped, so neither is live — the one check every surface
 * that means "skip what is not live" asks, so parking can't miss a path.
 */
export function isPutAway(
  session: UiSession,
  parked: ReadonlySet<string>
): boolean {
  return session.archivedAt !== null || parked.has(session.projectId);
}

/** The sessions still in sight — neither archived nor in a parked project. */
function liveSessions(
  sessions: Record<string, UiSession>,
  projects: readonly ProjectRow[]
): Record<string, UiSession> {
  const parked = parkedProjectIds(projects);
  return Object.fromEntries(
    Object.entries(sessions).filter(([, s]) => !isPutAway(s, parked))
  );
}

function newestSessionId(sessions: Record<string, UiSession>): string | null {
  let newest: UiSession | undefined;
  for (const s of Object.values(sessions)) {
    if (!newest || s.createdAt > newest.createdAt) {
      newest = s;
    }
  }
  return newest?.id ?? null;
}

/**
 * Record where a session's newest status came from, returning the previous map
 * unchanged when nothing moves — the common case is a live update for a session
 * already marked live, and a fresh object identity there would re-render every
 * Needs-you subscriber on each status tick.
 *
 * A seeded update never overwrites a `"live"` mark. The seed runs on its own
 * backend thread and can arrive after a live update for the same session;
 * letting it win would re-suppress a finish that really did happen this run.
 */
function markStatusOrigin(
  statusOrigin: Record<string, "seeded" | "live">,
  id: string,
  seeded: boolean
): Record<string, "seeded" | "live"> {
  const next: "seeded" | "live" = seeded ? "seeded" : "live";
  const current = statusOrigin[id];
  if (current === next || (seeded && current === "live")) {
    return statusOrigin;
  }
  return { ...statusOrigin, [id]: next };
}

/** Claude Code tools whose `PostToolUse` target is a file edit worth
 * attributing to the session (`touchedFiles`) — mirrors the plan's hook
 * event list for Code Changes View liveness. Read/Bash/Agent etc. don't
 * touch working-tree files, so they're not tracked. */
const EDIT_TOOL_NAMES = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

/** Built-in main-agent tools that provably never touch the working tree, so
 * their completion must NOT re-run the Changes diff. Everything else — edits,
 * `Bash` (`curl -o`, `mv`, `sed -i`, codegen), any `mcp__*` server tool, and
 * unknown/future tools — is treated as a potential mutator and does trigger a
 * refresh. The asymmetry is deliberate: an extra diff is cheap (persistent
 * scratch index, debounced, active-session-only), a missed change leaves the
 * view stale (the bug this guards). `Agent`/`Task` never appear here — a
 * subagent is tracked in `subagents[]`, not `main.currentTool` (see
 * {@link aSubagentJustCompleted}). */
const NON_MUTATING_TOOL_NAMES = new Set([
  "Read",
  "Grep",
  "Glob",
  "LS",
  "WebFetch",
  "WebSearch",
  "TodoWrite",
]);

/** `true` if a completed main tool could have changed the working tree — every
 * tool except the read-only built-ins in {@link NON_MUTATING_TOOL_NAMES}. */
function toolMayMutateTree(toolName: string): boolean {
  return !NON_MUTATING_TOOL_NAMES.has(toolName);
}

/**
 * The main-agent tool that just finished, or `null`.
 *
 * There is no raw `PostToolUse` event on the frontend — Claude Code ≥2.1
 * stops writing the transcript live (ADR 0003), so the only live per-session
 * signal is the `session-activity` snapshot, whose `main.currentTool` is set
 * on `PreToolUse` and cleared on `PostToolUse` (see
 * `crates/kriyon-core/src/activity.rs`). A completion is therefore inferred
 * from the *transition*: the previous snapshot held a tool, and the new
 * snapshot no longer shows that same tool+target running.
 */
function completedMainTool(
  prev: SessionActivity | undefined,
  next: SessionActivity
): ToolActivity | null {
  const prevTool = prev?.main.currentTool;
  if (!prevTool) {
    return null;
  }
  const nextTool = next.main.currentTool;
  const stillRunning =
    nextTool?.toolName === prevTool.toolName &&
    nextTool.target === prevTool.target;
  return stillRunning ? null : prevTool;
}

/** The file an edit tool just finished touching, or `null` — the attribution
 * signal for `touchedFiles`. Restricted to {@link EDIT_TOOL_NAMES} with a
 * concrete target; broader working-tree mutation (Bash) drives only the
 * refresh, via {@link completedRefreshTrigger}. */
function completedEditTarget(
  prev: SessionActivity | undefined,
  next: SessionActivity
): string | null {
  const done = completedMainTool(prev, next);
  return done && EDIT_TOOL_NAMES.has(done.toolName) && done.target
    ? done.target
    : null;
}

/** `true` when a completed main tool could have changed the working tree, so
 * the Changes-view diff must be re-run — every tool except the read-only
 * built-ins (see {@link NON_MUTATING_TOOL_NAMES}). */
function completedMutatingMainTool(
  prev: SessionActivity | undefined,
  next: SessionActivity
): boolean {
  const done = completedMainTool(prev, next);
  return Boolean(done && toolMayMutateTree(done.toolName));
}

/** `true` when a subagent just transitioned to `done` between snapshots. A
 * `Task`/`Agent` subagent's edits land under `subagents[]`, never as a
 * `main.currentTool` completion, so without this its work stays invisible in
 * the diff until an unrelated refresh. Keyed by `toolUseId`: a subagent that is
 * `done` now but was not `done` before (running, or absent on a missed
 * `PreToolUse`) just finished. Guarded on `prev` so a boot/seed snapshot full
 * of already-done subagents doesn't fire (the mount refresh covers that). */
function aSubagentJustCompleted(
  prev: SessionActivity | undefined,
  next: SessionActivity
): boolean {
  if (!prev) {
    return false;
  }
  const wasDone = new Set(
    prev.subagents.filter((s) => s.state === "done").map((s) => s.toolUseId)
  );
  return next.subagents.some(
    (s) => s.state === "done" && !wasDone.has(s.toolUseId)
  );
}

/** Append `path` to a session's touched-file list, ordered and deduped —
 * a re-touch of an already-recorded file is a no-op (keeps its first
 * position rather than bumping it to the end). */
function withTouchedFile(
  touchedFiles: Record<string, string[]>,
  sessionId: string,
  path: string
): Record<string, string[]> {
  const existing = touchedFiles[sessionId] ?? [];
  if (existing.includes(path)) {
    return touchedFiles;
  }
  return { ...touchedFiles, [sessionId]: [...existing, path] };
}

/** Stable empty-Set fallback for {@link sessionTouchedRelative}, mirroring
 * `changes.ts`'s `EMPTY_COLLAPSED` convention: a fresh `new Set()` on every
 * call would read as "always changed" to anything memoizing off it. Treat
 * as read-only — nothing in this module ever mutates it. */
export const EMPTY_TOUCHED_RELATIVE: Set<string> = new Set();

/**
 * `touched`, relativized against `toplevel` — an absolute path outside the
 * repo is dropped rather than kept as a nonsensical "relative" path (e.g.
 * `../elsewhere/x.ts`), since {@link FileDiff.path} is always repo-relative
 * and such an entry could never match one anyway.
 *
 * Known gap: the Rust `repo_toplevel` command canonicalizes `cwd` (realpath),
 * so `toplevel` is always a realpath, while `touchedFiles` holds whatever
 * (possibly symlinked) path the edit tool actually used. Under a symlinked
 * project path — macOS's `/tmp` → `/private/tmp`, or a symlinked home
 * directory — every prefix test here fails and every badge for that session
 * silently vanishes. This fails safe (no file is ever mis-attributed to the
 * wrong session), so it's left as-is rather than special-cased.
 */
export function relativizeTouchedPath(
  absPath: string,
  toplevel: string
): string | null {
  const root = toplevel.endsWith("/") ? toplevel.slice(0, -1) : toplevel;
  const prefix = `${root}/`;
  if (!absPath.startsWith(prefix)) {
    return null;
  }
  return absPath.slice(prefix.length);
}

/**
 * Per-session memo of {@link sessionTouchedRelative}'s result, keyed by the
 * `touchedFiles[sessionId]` array's own identity (a fresh array only on an
 * actual touch — see {@link withTouchedFile}) and the toplevel it was
 * computed against. Reading through this rather than recomputing on every
 * call is what keeps a per-file badge lookup in the diff feed a Set.has
 * during scroll, never a fresh relativize-and-rebuild walk of `touchedFiles`
 * per frame (Global Constraints: this app must stay fast and light).
 */
const touchedRelativeCache = new WeakMap<
  string[],
  { result: Set<string>; toplevel: string }
>();

/**
 * `sessionId`'s `touchedFiles` (absolute paths), relativized against its
 * cached {@link SessionsState.repoToplevel} entry — the set the "touched by
 * this session" badge and the "My edits only" filter both intersect a
 * diff's (repo-relative) `FileDiff.path` against. Empty until a toplevel has
 * been resolved for this session (the [Changes refresh coordinator]'s
 * `ensureRepoToplevel` does that) or the
 * session has never touched a file; an absolute path outside the repo
 * (never expected in practice, but not guaranteed) is silently dropped
 * rather than surfaced as a bogus relative path. See
 * {@link relativizeTouchedPath}'s doc comment for a known symlinked-path
 * gap (badges can silently vanish under e.g. macOS's `/tmp` symlink) that
 * applies to every path this function relativizes.
 *
 * Returns the exact same `Set` instance across calls as long as neither the
 * session's `touchedFiles` array nor its cached toplevel has changed (see
 * {@link touchedRelativeCache}) — safe to call on every render without
 * `useMemo` deps ever seeing a "changed" reference for identical inputs,
 * though callers still typically wrap it in `useMemo` keyed on those same
 * two reactive store fields so React doesn't even re-run this function
 * needlessly on unrelated re-renders.
 */
export function sessionTouchedRelative(sessionId: string): Set<string> {
  const state = useSessions.getState();
  const touched = state.touchedFiles[sessionId];
  const toplevel = state.repoToplevel[sessionId];
  if (!(touched && touched.length > 0 && toplevel)) {
    return EMPTY_TOUCHED_RELATIVE;
  }
  const cached = touchedRelativeCache.get(touched);
  if (cached && cached.toplevel === toplevel) {
    return cached.result;
  }
  const result = new Set<string>();
  for (const absPath of touched) {
    const rel = relativizeTouchedPath(absPath, toplevel);
    if (rel !== null) {
      result.add(rel);
    }
  }
  touchedRelativeCache.set(touched, { result, toplevel });
  return result;
}

/** Every {@link SessionsState} slice keyed by session id, so
 *  {@link pruneById} can never drift from the store's shape. */
const PER_SESSION_KEYS = [
  "activity",
  "appendSeq",
  "bootPhase",
  "cpu",
  "events",
  "exited",
  "hooksOff",
  "memory",
  "pendingReport",
  "pendingSeedPrompt",
  "repoToplevel",
  "repoToplevelCwd",
  "sleeping",
  "statusOrigin",
  "touchedFiles",
  "usage",
  "viewed",
] as const satisfies readonly (keyof SessionsState)[];

/**
 * Copies of every per-session map with `id` dropped — the one place a closed
 * session's state is released. Maps the id was never in are returned
 * unchanged (same identity), so a removal never invalidates a selector that
 * had nothing to do with the closed session.
 */
function pruneById(state: SessionsState, id: string): Partial<SessionsState> {
  const next: Record<string, unknown> = {};
  for (const key of PER_SESSION_KEYS) {
    const map = state[key] as Record<string, unknown>;
    // `in`, not Object.hasOwn: this project's tsc `lib` predates ES2022,
    // and Biome rewrites the hasOwnProperty.call form back to Object.hasOwn.
    if (!(id in map)) {
      continue;
    }
    const copy = { ...map };
    delete copy[id];
    next[key] = copy;
  }
  return next as Partial<SessionsState>;
}

export const useSessions = create<SessionsState>((set, get) => ({
  warmPanes: [],
  activeSessionId: null,
  activity: {},
  bootPhase: {},
  cpu: {},
  events: {},
  pendingReport: {},
  pendingSeedPrompt: {},
  statusOrigin: {},
  usage: {},
  memory: {},
  sleeping: {},
  hooksOff: {},
  exited: {},
  appendSeq: {},
  viewed: {},
  projects: [],
  sessions: {},
  touchedFiles: {},
  repoToplevel: {},
  repoToplevelCwd: {},

  addProject: (p) =>
    set((state) =>
      state.projects.some((existing) => existing.id === p.id)
        ? state
        : { projects: [...state.projects, p] }
    ),

  addSession: (s) =>
    set((state) => ({
      // The first session becomes active and so mounts via sessionPaneMounts;
      // no need to pre-warm it (or any background session) here.
      activeSessionId: state.activeSessionId ?? s.id,
      sessions: { ...state.sessions, [s.id]: s },
    })),

  setProjectColor: (projectId, color) =>
    set((state) => ({
      projects: state.projects.map((project) =>
        project.id === projectId ? { ...project, color } : project
      ),
    })),

  renameProject: (projectId, name) =>
    set((state) => {
      const trimmed = name.trim();
      const project = state.projects.find((p) => p.id === projectId);
      // Ignore an empty name or a no-op rename — neither should churn the store
      // (and an empty name would leave the header with nothing to show).
      if (!project || trimmed === "" || trimmed === project.name) {
        return state;
      }
      return {
        projects: state.projects.map((p) =>
          p.id === projectId ? { ...p, name: trimmed } : p
        ),
      };
    }),

  renameSession: (id, title) =>
    set((state) => {
      const trimmed = title.trim();
      const session = state.sessions[id];
      if (!session || trimmed === "") {
        return state;
      }
      // Always lock, even when the text is unchanged: the user asserting a name
      // is what pins it against future auto-titles, not that it happened to
      // differ from the current one.
      if (trimmed === session.title && session.titleLocked) {
        return state;
      }
      return {
        sessions: {
          ...state.sessions,
          [id]: { ...session, title: trimmed, titleLocked: true },
        },
      };
    }),

  setActiveSession: (id) =>
    set((state) => {
      if (state.activeSessionId === id) {
        return state;
      }
      const now = Date.now();
      const viewed = { ...state.viewed };
      const prev = state.activeSessionId;
      if (prev) {
        viewed[prev] = stampViewed({
          appendSeq: state.appendSeq[prev] ?? 0,
          nowMs: now,
          tasksDone: completedTasks(state.activity[prev]),
        });
      }
      viewed[id] = stampViewed({
        appendSeq: state.appendSeq[id] ?? 0,
        nowMs: now,
        tasksDone: completedTasks(state.activity[id]),
      });
      // Keep the tab we're leaving warm so its terminal stays mounted; the
      // arrival mounts as the active tab (sessionPaneMounts), needs no entry.
      // The warm set is LRU-bounded, so this may evict the coldest pane (its
      // xterm unmounts; the daemon lives on — see nextWarmPanes).
      const { warm } = nextWarmPanes(state.warmPanes, prev, id);
      // Opening a session is what launches it, so opening one in a [Parked
      // project] — from the palette, a notification, the Parked section —
      // brings the project back: a running session must never sit hidden.
      const projectId = state.sessions[id]?.projectId;
      const projects = state.projects.some(
        (p) => p.id === projectId && p.parkedAt !== null
      )
        ? state.projects.map((p) =>
            p.id === projectId ? { ...p, parkedAt: null } : p
          )
        : state.projects;
      return {
        warmPanes: warm,
        activeSessionId: id,
        projects,
        viewed,
      };
    }),

  setBaseline: (id, oid) => {
    // Captured before the write below: a baseline arriving for a session that
    // had none is the one transition that has to re-refresh (see
    // `refreshOnBaselineLanded`).
    const before = get().sessions[id];
    set((state) => {
      const session = state.sessions[id];
      if (!session) {
        return state;
      }
      const updated: UiSession = { ...session, baselineOid: oid };
      // Explicit re-persist rather than relying solely on the debounced
      // sweep in `persistence.ts`: that subscription is only installed once
      // the app boots (`installPersistence`), so a caller exercising the
      // session store in isolation (or a capture that resolves before the
      // sweep's first tick) would otherwise never see the oid written.
      ignore(upsertSession(sessionRow(updated)));
      return { sessions: { ...state.sessions, [id]: updated } };
    });
    refreshOnBaselineLanded(id, before, oid);
  },

  setRepoToplevel: (id, cwd, toplevel) =>
    set((state) =>
      toplevel === undefined
        ? { repoToplevelCwd: { ...state.repoToplevelCwd, [id]: cwd } }
        : { repoToplevel: { ...state.repoToplevel, [id]: toplevel } }
    ),

  noteSessionExited: (id) =>
    set((state) =>
      state.sessions[id] ? { exited: { ...state.exited, [id]: true } } : state
    ),

  applyStatus: (id, status, summary, seeded = false) =>
    set((state) => {
      const session = state.sessions[id];
      if (!session) {
        return state;
      }
      // A live status means claude is up: clear a still-showing loading overlay,
      // but never a detected resume failure (that stays until a real start).
      const phase = state.bootPhase[id] ?? "idle";
      const nextPhase = nextBootPhase(phase, "statusUpdate");
      // Only a running claude fires a hook, so a live update also retires a
      // recorded exit. A seeded one proves nothing: it was replayed from the
      // events file, and the process it describes may be long gone.
      const exited =
        seeded || state.exited[id] !== true
          ? state.exited
          : { ...state.exited, [id]: false };
      return {
        bootPhase:
          nextPhase === phase
            ? state.bootPhase
            : { ...state.bootPhase, [id]: nextPhase },
        exited,
        // A live update supersedes a replay: the session has done something
        // this run, so whatever it now reports is genuinely new to the user.
        statusOrigin: markStatusOrigin(state.statusOrigin, id, seeded),
        sessions: {
          ...state.sessions,
          [id]: { ...session, status, summary },
        },
      };
    }),

  applyTitle: (id, title) =>
    set((state) => {
      const session = state.sessions[id];
      // A manual rename wins for the session's life: once the user locks the
      // title, Claude's own `ai-title` updates are ignored (they still change,
      // but the sidebar keeps the name the user chose).
      if (!session || session.titleLocked || title === session.title) {
        return state;
      }
      return { sessions: { ...state.sessions, [id]: { ...session, title } } };
    }),

  applyClaudeId: (id, claudeSessionId) =>
    set((state) => {
      const session = state.sessions[id];
      if (!session || session.claudeSessionId === claudeSessionId) {
        return state;
      }
      return {
        sessions: { ...state.sessions, [id]: { ...session, claudeSessionId } },
      };
    }),

  applyBootEvent: (id, event) =>
    set((state) => {
      const phase = state.bootPhase[id] ?? "idle";
      const next = nextBootPhase(phase, event);
      if (next === phase) {
        return state;
      }
      return { bootPhase: { ...state.bootPhase, [id]: next } };
    }),

  archiveSession: (id) =>
    set((state) => {
      const session = state.sessions[id];
      if (!session || session.archivedAt !== null) {
        return state;
      }
      const sessions = {
        ...state.sessions,
        [id]: { ...session, archivedAt: Date.now() },
      };
      // Archiving stops the session's processes, so its terminal must leave the
      // screen and the warm set: a pane still wired to the stopped host would
      // sit dead, and would stay blank after an un-archive. The selection moves
      // to the newest session still in sight, exactly as a close would move it.
      const live = liveSessions(sessions, state.projects);
      return {
        activeSessionId:
          state.activeSessionId === id
            ? newestSessionId(live)
            : state.activeSessionId,
        sessions,
        warmPanes: state.warmPanes.filter((warmId) => warmId !== id),
      };
    }),

  parkProject: (projectId) =>
    set((state) => {
      const project = state.projects.find((p) => p.id === projectId);
      if (!project || project.parkedAt !== null) {
        return state;
      }
      const projects = state.projects.map((p) =>
        p.id === projectId ? { ...p, parkedAt: Date.now() } : p
      );
      // Parking stops every session in the project (see `parkProjectAndStop`),
      // so — exactly as archiving one does — their terminals leave the screen
      // and the warm set, and the selection moves to the newest session still
      // in sight.
      const inProject = (id: string) =>
        state.sessions[id]?.projectId === projectId;
      const active = state.activeSessionId;
      return {
        activeSessionId:
          active !== null && inProject(active)
            ? newestSessionId(liveSessions(state.sessions, projects))
            : active,
        projects,
        warmPanes: state.warmPanes.filter((warmId) => !inProject(warmId)),
      };
    }),

  unparkProject: (projectId) =>
    set((state) => {
      const project = state.projects.find((p) => p.id === projectId);
      if (!project || project.parkedAt === null) {
        return state;
      }
      // Nothing starts here: each session resumes only when it is opened.
      return {
        projects: state.projects.map((p) =>
          p.id === projectId ? { ...p, parkedAt: null } : p
        ),
      };
    }),

  unarchiveSession: (id) =>
    set((state) => {
      const session = state.sessions[id];
      if (!session || session.archivedAt === null) {
        return state;
      }
      return {
        sessions: { ...state.sessions, [id]: { ...session, archivedAt: null } },
      };
    }),

  removeSession: (id) => {
    // Prune the separate Code Changes View store (a closed session's full
    // SessionDiff would otherwise live for the app's lifetime) and its
    // [Usage card], then let the
    // [Changes refresh coordinator] release what it holds for this session
    // (a pending live-edit debounce, its [Working-tree watch]) — both before
    // this store's own set below drops the session. Each is a no-op for an
    // unknown id, so they're safe to run before the existence guard.
    useChanges.getState().dropSession(id);
    useUsageCards.getState().close(id);
    forgetSessionRefresh(id);
    set((state) => {
      if (!state.sessions[id]) {
        return state;
      }
      const sessions = { ...state.sessions };
      delete sessions[id];
      const activeSessionId =
        state.activeSessionId === id
          ? newestSessionId(sessions)
          : state.activeSessionId;
      // The survivor mounts as the new active tab (sessionPaneMounts); just
      // drop the removed id from the warm set so it can't leak a mount.
      const warmPanes = state.warmPanes.filter((warmId) => warmId !== id);
      // Every remaining map keyed by session id goes with it. Two of these
      // carry correctness, not just bytes: `statusOrigin` decides whether a
      // session can appear in Needs-you, and `sleeping` paints the moon — a
      // stale entry in either would be inherited by any future session that
      // reused the id. The rest are memory: `events` alone holds up to
      // {@link MAX_EVENTS} parsed transcript entries per session, so closing a
      // whole project's worth at once used to strand that many rings until
      // quit. Prune them together, and a map added later joins this list
      // rather than the leak (see the shape assertion in the tests).
      const pruned = pruneById(state, id);
      return { warmPanes, activeSessionId, sessions, ...pruned };
    });
  },

  appendEvent: (sessionId, event) =>
    set((state) => {
      const existing = state.events[sessionId];
      const seen = seenIdsFor(existing);
      // Dedupe by stable id in O(1): re-tailing the transcript from the start
      // (as `claude --resume` causes) replays the same ids, so a re-seen event
      // is a no-op. This is what makes restoring a session idempotent.
      if (seen.has(event.id)) {
        return state;
      }
      const next = (existing ?? []).concat(event);
      seen.add(event.id);
      const capped = capEvents(next, seen);
      // Carry the (in-place mutated) set forward under the new array's identity.
      // Safe because the store now points at `capped`: the prior `existing`
      // array is never appended to again, so its stale WeakMap entry is unused.
      seenEventIds.set(capped, seen);
      return {
        appendSeq: {
          ...state.appendSeq,
          [sessionId]: (state.appendSeq[sessionId] ?? 0) + 1,
        },
        events: { ...state.events, [sessionId]: capped },
      };
    }),

  appendEvents: (sessionId, incoming) =>
    set((state) => {
      const existing = state.events[sessionId];
      const seen = seenIdsFor(existing);
      const fresh = incoming.filter((event) => {
        if (seen.has(event.id)) {
          return false;
        }
        seen.add(event.id);
        return true;
      });
      if (fresh.length === 0) {
        return state;
      }
      const capped = capEvents((existing ?? []).concat(fresh), seen);
      seenEventIds.set(capped, seen);
      return {
        appendSeq: {
          ...state.appendSeq,
          [sessionId]: (state.appendSeq[sessionId] ?? 0) + fresh.length,
        },
        events: { ...state.events, [sessionId]: capped },
      };
    }),

  clearEvents: (sessionId) =>
    set((state) => ({
      events: { ...state.events, [sessionId]: [] },
    })),

  consumePendingReport: (id) => {
    const report = get().pendingReport[id];
    if (report !== undefined) {
      set((state) => {
        const next = { ...state.pendingReport };
        delete next[id];
        return { pendingReport: next };
      });
    }
    return report;
  },

  consumePendingSeedPrompt: (id) => {
    const text = get().pendingSeedPrompt[id];
    if (text !== undefined) {
      set((state) => {
        const next = { ...state.pendingSeedPrompt };
        delete next[id];
        return { pendingSeedPrompt: next };
      });
    }
    return text;
  },

  applyUsage: (id, snapshot) =>
    set((state) => ({ usage: { ...state.usage, [id]: snapshot } })),

  // Replaced wholesale (not merged): a session missing from a sweep is closed,
  // and its stale reading must not survive it.
  applyResources: (update) =>
    set(() => ({ cpu: update.cpu, memory: update.sessions })),

  applyHooksOff: (sessionId, scope) =>
    set((state) => {
      // A Project terminal pane shares the create command but is no session,
      // and nothing would ever clear its entry.
      if (!state.sessions[sessionId]) {
        return state;
      }
      const next = { ...state.hooksOff };
      if (scope === null) {
        delete next[sessionId];
      } else {
        next[sessionId] = scope;
      }
      return { hooksOff: next };
    }),

  applySleeping: (sessionId, phase) =>
    set((state) => {
      const next = { ...state.sleeping };
      if (phase === "awake") {
        delete next[sessionId];
      } else {
        next[sessionId] = phase;
      }
      return { sleeping: next };
    }),

  applyActivity: (id, snapshot) =>
    set((state) => {
      const prev = state.activity[id];
      const completedTarget = completedEditTarget(prev, snapshot);
      // Refresh whenever the working tree may have changed — any non-read main
      // tool finishing (edits, Bash, MCP, unknown) or a subagent completing.
      // Attribution (touchedFiles) stays edit-only; this only decides when to
      // re-run the git diff, which remains the source of truth for *what*
      // changed.
      if (
        completedMutatingMainTool(prev, snapshot) ||
        aSubagentJustCompleted(prev, snapshot)
      ) {
        requestRefresh(id, "live-edit");
      }
      return {
        activity: { ...state.activity, [id]: snapshot },
        touchedFiles: completedTarget
          ? withTouchedFile(state.touchedFiles, id, completedTarget)
          : state.touchedFiles,
      };
    }),

  setPendingSeedPrompt: (id, text) =>
    set((state) => ({
      pendingSeedPrompt: { ...state.pendingSeedPrompt, [id]: text },
    })),

  setPendingReport: (id, report) =>
    set((state) => ({
      pendingReport: { ...state.pendingReport, [id]: report },
    })),

  warmSession: (id) =>
    set((state) => {
      if (state.activeSessionId === id || state.warmPanes.includes(id)) {
        return {};
      }
      return {
        warmPanes: nextWarmPanes(
          state.warmPanes,
          id,
          state.activeSessionId ?? ""
        ).warm,
      };
    }),
}));
