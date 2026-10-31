import {
  type BootstrapReport,
  bootstrapWorktree,
  captureBaseline,
  createWorktree,
  isTauriRuntime,
  pickDirectory,
  sleepIdleSessions,
  upsertProject,
  upsertSession,
  worktreePathFor,
} from "../ipc/bridge.ts";
import {
  disposeSession,
  ensureSession,
  launchClaudeOnce,
  noteSessionStarted,
  startFreshClaude,
} from "../terminal/sessionHost.ts";
import type {
  NestedReport,
  PastSession,
  ProjectRow,
  SessionRow,
} from "../types.ts";
import { showToast } from "../ui/Toast.tsx";
import { markBootLive, markBootStart } from "./bootTiming.ts";
import { useCompletions } from "./completions.ts";
import { useLayout } from "./layout.ts";
import {
  idleSession,
  isPutAway,
  sessionRow,
  type UiSession,
  useSessions,
} from "./sessions.ts";
import {
  freedMemoryNote,
  hasTotalStopCost,
  plural,
  stopCostOfAll,
  type TotalStopCost,
} from "./stopCost.ts";
import { projectPaneIds, useTerminals } from "./terminals.ts";
import { sessionPaneMounts } from "./warmPanes.ts";

/**
 * Archive a session: tidy it out of sight **and stop its processes**. The row,
 * the Claude transcript and the worktree all stay, so un-archiving and opening
 * it again resumes the conversation (`claude --resume`) in a fresh terminal.
 *
 * Every archive goes through here. Setting the flag alone — what archiving used
 * to do — left the session's `claude` running where nobody could see it,
 * holding memory until the machine rebooted. Stopping is fire-and-forget:
 * `disposeSession` never rejects, and the flag must not wait on a socket.
 */
export function archiveSessionAndStop(sessionId: string): void {
  const freed = freedMemoryNote(
    "Archived",
    useSessions.getState().memory[sessionId]
  );
  disposeSession(sessionId).catch(() => {
    // Unreachable: disposeSession swallows its own failures.
  });
  useSessions.getState().archiveSession(sessionId);
  if (freed) {
    showToast(freed);
  }
}

/**
 * What parking a project would stop — read by its confirm and its toast: the
 * same [Stop cost] the quit gate adds up, over the project's sessions still on
 * the rail, plus its busy terminals. Built from `stopCostOfAll` and
 * `hasTotalStopCost`, so parking can never warn about less than quitting would.
 */
export interface ParkCost extends TotalStopCost {
  /** Terminal panes with a command running. */
  busyTerminals: number;
  /** The sessions parking stops (every one still on the rail). */
  sessionIds: string[];
}

export function projectParkCost(projectId: string): ParkCost {
  const state = useSessions.getState();
  const sessions = Object.fromEntries(
    Object.entries(state.sessions).filter(
      ([, session]) => session.projectId === projectId && !isPutAway(session)
    )
  );
  const terminals = useTerminals.getState();
  return {
    ...stopCostOfAll({ ...state, sessions }),
    busyTerminals: projectPaneIds(terminals.byProject, projectId).filter((id) =>
      terminals.isPaneBusy(id)
    ).length,
    sessionIds: Object.keys(sessions),
  };
}

/** Whether parking would stop any work in flight — when its confirm is owed. */
export function hasParkCost(cost: ParkCost): boolean {
  return hasTotalStopCost(cost) || cost.busyTerminals > 0;
}

/**
 * Park a project: put it away and stop everything it runs (ADR-0052). Every
 * session still on the rail is parked and stopped, and so is every [Project
 * terminal]; rows, titles, order, transcripts, worktrees and terminal tabs all
 * stay. The parked rows are saved at once, before the stops, so a crash
 * mid-stop still leaves them parked and the orphan sweep finishes the job.
 */
export function parkProjectAndStop(projectId: string): void {
  const state = useSessions.getState();
  const project = state.projects.find((p) => p.id === projectId);
  if (!project) {
    return;
  }
  const { sessionIds } = projectParkCost(projectId);
  const paneCount = projectPaneIds(
    useTerminals.getState().byProject,
    projectId
  ).length;
  if (sessionIds.length === 0 && paneCount === 0) {
    return;
  }
  state.parkProject(projectId);
  if (isTauriRuntime()) {
    const { sessions } = useSessions.getState();
    for (const id of sessionIds) {
      const session = sessions[id];
      if (session) {
        ignore(upsertSession(sessionRow(session)));
      }
    }
  }
  for (const id of sessionIds) {
    ignore(disposeSession(id));
  }
  useTerminals.getState().stopProject(projectId);
  const stopped =
    paneCount > 0
      ? `${plural(sessionIds.length, "session")} and ${plural(paneCount, "terminal")}`
      : plural(sessionIds.length, "session");
  showToast(`Parked ${project.name} · ${stopped} stopped`);
}

/**
 * "Sleep idle sessions now": get memory back without quitting. Every quiescent
 * session is put to sleep at once, whatever the auto-sleep setting; one that is
 * mid-turn, on screen, or running a subagent or background command is never
 * touched. Always says what happened — a command that frees memory invisibly,
 * or does nothing silently, looks broken either way.
 */
export async function sleepIdleSessionsNow(): Promise<void> {
  let slept: number;
  try {
    slept = await sleepIdleSessions();
  } catch (error) {
    showToast(
      `Could not sleep idle sessions: ${error instanceof Error ? error.message : String(error)}`,
      "error"
    );
    return;
  }
  if (slept === 0) {
    showToast(
      "Nothing to sleep — every session is busy, on screen, or already asleep"
    );
    return;
  }
  showToast(
    slept === 1
      ? "1 session going to sleep — it wakes when you open it"
      : `${slept} sessions going to sleep — each wakes when you open it`
  );
}

/**
 * The resolved absolute home directory, fetched once at startup. Used as the
 * cwd for default "Home" sessions so the pty and the transcript watcher resolve
 * the same real path (an empty cwd makes the watcher look in the wrong place).
 */
let defaultCwd = "";

/**
 * How long a session may show the loading overlay before it is force-cleared.
 * The safety net for a boot/resume whose `SessionStart` never reaches the
 * frontend; the primary launch path (App) arms it, and every in-place restart
 * must too, or the overlay can hang forever.
 */
export const BOOT_TIMEOUT_MS = 20_000;

/** Stash the resolved home path; called once at startup. */
export function setDefaultCwd(path: string): void {
  defaultCwd = path;
}

/** Last path segment of an absolute path, e.g. `/a/b/c` → `c`. */
export function basename(path: string): string {
  return path.split("/").filter(Boolean).pop() ?? path;
}

/**
 * Persist a project + session row to the backend store, then warm the
 * completion catalog for its cwd. Ordering matters: the `list_slash_commands`
 * probe validates its `cwd` against the store's known session/project roots (the
 * IPC trust boundary), so the row must exist there before the probe runs. The
 * debounced persistence subscription would not have written it yet at this
 * point, so we persist explicitly here and chain the warmup. Fire-and-forget —
 * the composer degrades gracefully if any of this never resolves. In the
 * browser (no backend) it just warms; `listSlashCommands` degrades on its own.
 */
/** Swallow a fire-and-forget promise's rejection (the persistence layer's
 * idiom): an intake-time backend write must never surface as an unhandled
 * rejection, and the debounced persistence subscription retries it anyway. */
function ignore(promise: Promise<unknown>): void {
  promise.catch(() => {
    // Intentionally empty: best-effort write, caller degrades gracefully.
  });
}

function persistThenWarm(project: ProjectRow, session: SessionRow): void {
  const warm = (): void => {
    ignore(useCompletions.getState().warmup(session.cwd));
  };
  if (!isTauriRuntime()) {
    warm();
    return;
  }
  ignore(
    Promise.allSettled([upsertProject(project), upsertSession(session)]).then(
      warm
    )
  );
}

/**
 * Make sure `project` is in the store, returning the store's row for it — the
 * row that gets persisted, since the caller's copy may be a fresh one built
 * from a folder pick.
 */
function ensureProject(project: ProjectRow): ProjectRow {
  const state = useSessions.getState();
  // `addProject` is a no-op if the project id already exists.
  state.addProject(project);
  return (
    useSessions.getState().projects.find((p) => p.id === project.id) ?? project
  );
}

/**
 * Open a new session in `project` (created if absent), with `cwd` and `title`.
 * The one intake transaction: ensure the project, build the row, add it, and make
 * it active — all in one place so a new field or side effect has a single home.
 * Making it active is what launches `claude` (the active-session effect in `App`
 * launches/resumes a session the first time it is viewed).
 */
export function createSession(
  project: ProjectRow,
  cwd: string,
  title: string,
  opts?: {
    /** Show it at once (the default). A [Nested session] Claude started is
     *  opened in the background instead, as a [Warm pane]. */
    focus?: boolean;
    nestedUnder?: string;
    parentSessionId?: string;
    /** Where a [Nested session] sends its first answer. */
    report?: NestedReport;
    seedPrompt?: string;
    worktreePath?: string | null;
  }
): string {
  const state = useSessions.getState();
  const stored = ensureProject(project);
  const id = crypto.randomUUID();
  const row: SessionRow = {
    archivedAt: null,
    baselineOid: null,
    claudeSessionId: null,
    createdAt: Date.now(),
    cwd,
    id,
    nestedUnder: opts?.nestedUnder ?? null,
    parentSessionId: opts?.parentSessionId ?? null,
    projectId: project.id,
    title,
    titleLocked: false,
    worktreePath: opts?.worktreePath ?? null,
  };
  state.addSession(idleSession(row));
  if (opts?.seedPrompt) {
    state.setPendingSeedPrompt(id, opts.seedPrompt);
  }
  if (opts?.report) {
    state.setPendingReport(id, opts.report);
  }
  if (opts?.focus === false) {
    // Mounted out of sight, then launched: the activation effect that starts
    // a shown session never runs for it.
    state.warmSession(id);
    persistThenWarm(stored, row);
    // Its [Boot phase] reads `launching` from this call on, so a second
    // request in the same batch counts it against the [Nested session cap].
    ignore(launchActiveSession(id));
    captureBaselineFor(id, cwd);
    return id;
  }
  // `addSession` only activates the *first* session, so switch explicitly —
  // otherwise a new session opened while another is active is created hidden.
  // `revealSessionView` for the same reason: `+` lives in the sidebar, which
  // is on screen in Settings and Prompts too, and a session created behind a
  // full view is indistinguishable from a button that did nothing.
  state.setActiveSession(id);
  useLayout.getState().revealSessionView();
  // Persist the row, then warm the composer's slash-command catalog for this
  // cwd so it's ready before the user's first `/`.
  persistThenWarm(stored, row);
  // Fire-and-forget: capture a git baseline for the Changes view to diff
  // against later. Must never block session creation or throw — `ignore`
  // swallows a rejection (cwd isn't a git repo, capture failed), leaving
  // `baselineOid` null, which the Changes view already treats as "fall back
  // to the whole-working-tree diff path".
  //
  // Skipped entirely for the default ("Home") cwd: `captureBaseline` runs
  // `git add -A` over the whole tree (see `snapshot_tree`), and if `~` is
  // itself a git repo (a dotfiles checkout — common), that walks and
  // content-hashes every non-ignored file under the user's HOME directory,
  // blocking a pool thread for minutes and permanently growing
  // `~/.git/objects` — once per Home session. There is no real "project" to
  // baseline for a Home session anyway.
  captureBaselineFor(id, cwd);
  return id;
}

/** Capture the session's git baseline, except for the Home cwd (see
 *  {@link createSession}). Never blocks and never throws. */
function captureBaselineFor(id: string, cwd: string): void {
  if (cwd !== defaultCwd) {
    ignore(
      captureBaseline(cwd).then((oid) =>
        useSessions.getState().setBaseline(id, oid)
      )
    );
  }
}

/**
 * Create a session in the `default` ("Home") project. The cwd is the user's
 * home directory.
 */
export function createSessionInDefaultProject(): void {
  createSession(
    {
      color: null,
      id: "default",
      name: "Home",
      path: defaultCwd,
      setupCommand: null,
    },
    defaultCwd,
    "Session"
  );
}

/**
 * Create a session whose working directory is `path`. The folder becomes a
 * project (keyed by its absolute path, named after its last segment) so all
 * sessions opened against the same folder group under one workspace.
 */
export function createSessionInFolder(path: string): void {
  const name = basename(path);
  createSession(
    { color: null, id: path, name, path, setupCommand: null },
    path,
    name
  );
}

/**
 * Create a session in an existing project right away (the sidebar's quick
 * per-project "+" — runs in the project folder on the current branch). The
 * worktree path goes through the spawn dialog instead, which needs a branch
 * name and explains the trade-off.
 */
export function createSessionInProject(project: ProjectRow): void {
  createSession(project, project.path, project.name);
}

/**
 * Resume a discovered past session into a live one. Ensures the folder is a
 * project, then creates a session row carrying Claude's own session id and
 * activates it — which makes the activation-launch effect in `App` run
 * `claude --resume <claude-id>`, restoring the session's terminal. The
 * past session's `cwd` is trusted as its working directory (Claude wrote it).
 */
export function resumePastSession(past: PastSession): void {
  const state = useSessions.getState();
  const cwd = past.cwd ?? defaultCwd;
  const name = basename(cwd);
  const project: ProjectRow = {
    color: null,
    id: cwd,
    name,
    path: cwd,
    setupCommand: null,
  };
  const stored = ensureProject(project);
  const id = crypto.randomUUID();
  const row: SessionRow = {
    archivedAt: null,
    baselineOid: null,
    claudeSessionId: past.claudeSessionId,
    createdAt: Date.now(),
    cwd,
    id,
    projectId: cwd,
    // Show the label the user clicked: Claude's ai-title if any, else the
    // first prompt, else the folder name. `claude --resume` re-emits the
    // ai-title once it boots, which then refreshes this in place.
    title: past.title ?? past.preview ?? name,
    titleLocked: false,
    worktreePath: null,
  };
  state.addSession(idleSession(row));
  state.setActiveSession(id);
  useLayout.getState().revealSessionView();
  // Persist + warm so the composer's completions validate against a known root
  // and are ready before the first `/`, the same as a fresh session.
  persistThenWarm(stored, row);
}

/**
 * The "New session" entry point: ask the user for a folder, then open a session
 * there. Cancelling the picker does nothing. In the browser (no picker) it
 * falls back to a Home session so the button still works for visual QA.
 */
export async function startNewSession(): Promise<void> {
  const path = await pickDirectory();
  if (path) {
    createSessionInFolder(path);
    return;
  }
  if (!isTauriRuntime()) {
    createSessionInDefaultProject();
  }
}

/**
 * Spawn a session, optionally in a fresh [Worktree]. Two intakes share this:
 * a [Follow-up session] from `predecessor` (seeded with `promptText`), and a
 * project-anchored spawn (no predecessor — the sidebar's "new worktree
 * session"). When `worktree` is given, create and bootstrap the [Worktree]
 * first and run the session there; otherwise run in the predecessor's working
 * directory (or the project root when there is none). Returns the bootstrap
 * report (if any) so the UI can surface a failed setup.
 */
export function spawnFollowUpSession(args: {
  predecessor?: UiSession;
  project: ProjectRow;
  promptText: string;
  worktree: { branch: string; path?: string } | null;
}): Promise<SpawnResult> {
  const { predecessor, project, promptText, worktree } = args;
  let title = project.name;
  if (worktree) {
    title = worktree.branch;
  } else if (predecessor) {
    title = `${predecessor.title} (follow-up)`;
  }

  if (!worktree) {
    createSession(project, predecessor?.cwd ?? project.path, title, {
      parentSessionId: predecessor?.id,
      seedPrompt: promptText,
    });
    return Promise.resolve({ bootstrap: null, error: null, ok: true });
  }

  return createWorktreeSession(project, worktree, title, {
    parentSessionId: predecessor?.id,
    seedPrompt: promptText,
  });
}

/** What starting a session reports: a failed setup step still made the
 *  worktree and the session (`ok: false` with the `bootstrap` report), while
 *  `error` without a report means nothing was created. */
export interface SpawnResult {
  bootstrap: BootstrapReport | null;
  error: string | null;
  ok: boolean;
}

/**
 * Make a fresh [Worktree] of `project` on `worktree.branch` (at the chosen
 * path, or the sibling one the Rust core picks), run its [Worktree
 * bootstrap], then start a session in it. The one worktree intake, shared by
 * follow-ups and [Nested session]s.
 */
export async function createWorktreeSession(
  project: ProjectRow,
  worktree: { branch: string; path?: string },
  title: string,
  opts: Omit<NonNullable<Parameters<typeof createSession>[3]>, "worktreePath">
): Promise<SpawnResult> {
  const repoRoot = project.path;
  try {
    // Use the caller's chosen location when given; otherwise the default
    // sibling path (`<repo>-worktrees/<branch>`) resolved by the Rust core.
    const path =
      worktree.path ?? (await worktreePathFor(repoRoot, worktree.branch));
    await createWorktree(repoRoot, worktree.branch, path);
    const bootstrap = await bootstrapWorktree(
      repoRoot,
      path,
      project.setupCommand
    );
    createSession(project, path, title, { ...opts, worktreePath: path });
    return { bootstrap, error: null, ok: bootstrap.ok };
  } catch (e) {
    return {
      bootstrap: null,
      error: e instanceof Error ? e.message : String(e),
      ok: false,
    };
  }
}

/**
 * The single boot-overlay safety-net timer per session, owned here so the
 * [Boot phase] machine (not a React effect) controls it. Keyed by session id;
 * {@link armBootTimeout} cancels any prior timer before arming a new one, so a
 * timer from an earlier boot cycle can never fire during a later one and clear
 * its overlay early.
 */
const bootTimers = new Map<string, ReturnType<typeof setTimeout>>();

/** Cancel and forget a session's pending boot-timeout, if any. */
function clearBootTimeout(sessionId: string): void {
  const timer = bootTimers.get(sessionId);
  if (timer !== undefined) {
    clearTimeout(timer);
    bootTimers.delete(sessionId);
  }
}

/** (Re)arm the boot safety net, replacing any timer from a prior boot cycle. */
function armBootTimeout(sessionId: string): void {
  clearBootTimeout(sessionId);
  bootTimers.set(
    sessionId,
    setTimeout(() => {
      bootTimers.delete(sessionId);
      useSessions.getState().applyBootEvent(sessionId, "timeout");
    }, BOOT_TIMEOUT_MS)
  );
}

/**
 * A resumed/started session is live for real (its `SessionStart` hook fired):
 * the transition that ends the boot/resume lifecycle. Disarm the resume-failure
 * watchdog, cancel the safety-net timer, and advance the [Boot phase] to `live`
 * (which clears both the loading overlay and any recovery prompt at once).
 */
export function sessionBecameLive(sessionId: string): void {
  noteSessionStarted(sessionId);
  markBootLive(sessionId, Date.now());
  clearBootTimeout(sessionId);
  useSessions.getState().applyBootEvent(sessionId, "started");
}

/**
 * The resume watchdog (in sessionHost) detected a `claude --resume` that never
 * started: cancel the safety-net timer and move the [Boot phase] to
 * `resumeFailed` so the recovery prompt replaces the loading overlay.
 */
export function noteResumeFailed(sessionId: string): void {
  // With Kriyon's hooks off ([Hooks off]) even a resume that worked never
  // fires SessionStart, so the watchdog can't tell it from one that failed.
  // Say nothing; the boot timeout still clears the loading overlay.
  if (useSessions.getState().hooksOff[sessionId]) {
    return;
  }
  clearBootTimeout(sessionId);
  useSessions.getState().applyBootEvent(sessionId, "resumeFailed");
}

/**
 * A `claude` launch is genuinely underway in this session's pty: move the [Boot
 * phase] to `booting` (showing the overlay) and arm its safety net. The timeout
 * belongs to the session, not to whichever pane is active — switching away
 * never cancels it, and re-entering ({@link armBootTimeout}) replaces the prior
 * cycle's timer so a stale one can't clear a later boot.
 */
export function beginBoot(sessionId: string): void {
  const state = useSessions.getState();
  state.applyBootEvent(sessionId, "launch");
  armBootTimeout(sessionId);
  markBootStart(sessionId, Date.now());
}

/**
 * Open a session's pty (its shell) ahead of the click, when the pointer rests
 * on a sidebar row whose pane isn't mounted yet: the user's zsh startup then
 * runs while they move to click, and opening the session only has `claude`
 * left to start. Never launches `claude` — a hover must not spend the user's
 * plan or memory on a session they may not open — and never complains: the
 * activation that follows retries and reports its own failure.
 */
export async function prewarmSession(sessionId: string): Promise<void> {
  const state = useSessions.getState();
  const session = state.sessions[sessionId];
  if (
    !session ||
    sessionPaneMounts(state.activeSessionId, state.warmPanes, sessionId)
  ) {
    return;
  }
  try {
    await ensureSession(sessionId, session.cwd, () => undefined);
  } catch {
    // The click's own activation retries and says so.
  }
}

/** The launch attempt in flight for each session, so overlapping calls join
 *  one attempt and only that attempt opens and settles the [Boot phase]. */
const launchAttempts = new Map<string, Promise<void>>();

/**
 * Launch (or resume) `claude` in a session's pty the first time it is viewed,
 * and track the boot lifecycle. Extracted from the App activation effect so the
 * boot state is armed unconditionally once a launch really happened — the
 * effect's cleanup must not be able to skip it (the user switching away
 * mid-launch is routine). Idempotent per session via `launchClaudeOnce`, and
 * a call made while an attempt is in flight joins that attempt.
 */
export function launchActiveSession(sessionId: string): Promise<void> {
  const inFlight = launchAttempts.get(sessionId);
  if (inFlight) {
    // A background start and the user's click, or a quick switch away and
    // back: the same attempt, not a second one that could settle it early.
    return inFlight;
  }
  const attempt = launchAttempt(sessionId).finally(() => {
    launchAttempts.delete(sessionId);
  });
  launchAttempts.set(sessionId, attempt);
  return attempt;
}

/**
 * One launch attempt: `launching` from its start until it settles, so every
 * reader of the [Boot phase] that asks `isStarting` (the cap, the quit
 * warning, the row spinner) sees a session that is starting. A session
 * already live or booting keeps its phase (`open` only moves one at rest).
 */
async function launchAttempt(sessionId: string): Promise<void> {
  const state = useSessions.getState();
  const session = state.sessions[sessionId];
  if (!session) {
    return;
  }
  state.applyBootEvent(sessionId, "open");
  try {
    await launchInPty(sessionId, session);
  } finally {
    // Every way out that didn't launch claude — a pty that failed, a reattach,
    // a failed write, a throw — puts the session back at rest. A launch that
    // happened has already moved it to `booting`, which this leaves alone.
    useSessions.getState().applyBootEvent(sessionId, "noLaunch");
  }
}

/** Open the session's pty and launch (or resume) `claude` in it. */
async function launchInPty(
  sessionId: string,
  session: UiSession
): Promise<void> {
  const state = useSessions.getState();
  // Idempotent for a live pty; for a session whose creation failed earlier
  // this is the retry — every activation gets one, so a transient failure
  // (daemon spawn timeout, stale socket) heals on the next visit instead of
  // wedging the pane blank forever.
  try {
    await ensureSession(sessionId, session.cwd, () =>
      showToast("Could not start the session", "error")
    );
  } catch {
    return;
  }
  const result = await launchClaudeOnce(
    sessionId,
    session.claudeSessionId,
    state.consumePendingSeedPrompt(sessionId),
    state.consumePendingReport(sessionId)
  );
  switch (result.kind) {
    case "launched":
      beginBoot(sessionId);
      break;
    case "seedDropped":
      // The session started, just without the follow-up prompt it was seeded
      // with — tell the user so they can re-enter it instead of wondering why
      // claude is idle.
      beginBoot(sessionId);
      showToast(
        "Could not send the first prompt — enter it in the terminal",
        "error"
      );
      break;
    case "writeFailed":
      // Nothing launched, so no boot overlay: surface the failure directly.
      showToast("Could not start the session", "error");
      break;
    default:
      // `reattached` (claude already live) or `skipped` (nothing to do).
      break;
  }
}

/**
 * The user chose "start fresh" on a failed-resume prompt: show the loading
 * overlay again and launch a plain `claude` in the same pty. `beginBoot`'s
 * `launch` event moves `resumeFailed` straight back to `booting`, so the
 * recovery prompt clears without a separate dismiss.
 */
export function restartSessionFresh(sessionId: string): void {
  beginBoot(sessionId);
  ignore(startFreshClaude(sessionId));
}

/**
 * Focus the session a clicked OS notification points at, routing to its Raw
 * view — the same landing as the Needs-you overlay's Enter. `sessionId` crosses
 * the IPC trust boundary, so an unknown id is ignored rather than trusted.
 */
export function focusSessionFromNotification(sessionId: string): void {
  const sessions = useSessions.getState();
  if (!sessions.sessions[sessionId]) {
    return;
  }
  sessions.setActiveSession(sessionId);
  useLayout.getState().revealSessionView();
}
