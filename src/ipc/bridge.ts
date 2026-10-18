import { Channel, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import type {
  DirEntry,
  FileContent,
  FileWriteResult,
  HooksOffScope,
  MergeOutcome,
  NotifyPreference,
  NotifySound,
  PastSessionPage,
  PendingAsk,
  PlanLimits,
  ProjectRow,
  RepoStatus,
  SavedPrompt,
  SessionActivity,
  SessionDiff,
  SessionRow,
  SessionStatus,
  StudioEvent,
  UsageSnapshot,
} from "../types.ts";

/**
 * True only inside the Tauri webview, where `__TAURI_INTERNALS__` is injected.
 * In a plain browser (used for visual QA) the IPC primitives — notably
 * `new Channel()` — throw synchronously, so the Channel-creating helpers below
 * short-circuit to harmless no-ops when this is false.
 */
function hasTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/** Public form of {@link hasTauri} for callers that branch on the runtime. */
export function isTauriRuntime(): boolean {
  return hasTauri();
}

/**
 * Build an `on*` backend-event subscriber: resolves to a no-op unlisten
 * outside the Tauri webview (browser QA), otherwise forwards each event's
 * payload straight to `cb`. Every plain `on<Thing>` export below is this
 * factory applied to its event name; {@link onFocusSession} and the
 * `onShowAbout` / `onNewSession` / `onOpenPreferences` trio wrap it instead of
 * aliasing it directly, since their callback shape isn't "payload in, payload
 * out".
 */
function subscribe<T>(
  event: string
): (cb: (payload: T) => void) => Promise<() => void> {
  return (cb) => {
    if (!hasTauri()) {
      return Promise.resolve(() => {
        // No Tauri runtime (browser QA): nothing to unlisten.
      });
    }
    return listen<T>(event, (e) => cb(e.payload));
  };
}

/** A status update emitted by the backend for one session. */
export interface StatusUpdate {
  /**
   * For a seeded update, when the newest replayed event actually happened (ISO
   * timestamp). Absent on a live update, and on a replay with no timestamps.
   * The recency projection stamps this instead of "now", so a launch replay
   * doesn't make every session look freshly active.
   */
  lastEventAt?: string | null;
  /**
   * True when the backend reconstructed this status by replaying the session's
   * events file at launch, rather than observing it live. A replayed finish is
   * output the user saw days ago — see {@link SessionsState.seededStatus}.
   * Optional so a pre-`seeded` backend (or a test fixture) reads as live.
   */
  seeded?: boolean;
  sessionId: string;
  status: SessionStatus;
  summary: string;
}

/**
 * Open (or reattach to) the session's pty daemon. Resolves to `true` when it
 * reattached to a daemon that survived a previous app run — meaning `claude` is
 * already running in its shell and must NOT be re-launched — and `false` for a
 * freshly spawned daemon.
 */
export function createSession(
  id: string,
  cwd: string,
  onBytes: (bytes: Uint8Array) => void,
  onBusy: (busy: boolean) => void,
  onExit: () => void
): Promise<boolean> {
  if (!hasTauri()) {
    return Promise.resolve(false);
  }
  const channel = new Channel<ArrayBuffer>();
  channel.onmessage = (msg) => onBytes(new Uint8Array(msg));
  const busyChannel = new Channel<boolean>();
  busyChannel.onmessage = (busy) => onBusy(busy);
  // Fired once if the session dies underneath the app (shell exited, daemon
  // crashed) — never for an app-initiated close or client handover.
  const exitChannel = new Channel<boolean>();
  exitChannel.onmessage = () => onExit();
  return invoke<boolean>("create_session", {
    id,
    cwd,
    onBusy: busyChannel,
    onExit: exitChannel,
    onOutput: channel,
  });
}

/**
 * Ask the session's daemon to resend its screen snapshot (arrives as normal
 * output). Used when a terminal component (re)attaches to a live session,
 * whose fresh xterm starts blank.
 */
export function requestRepaint(id: string): Promise<void> {
  return invoke("request_repaint", { id });
}

/**
 * Tell the backend the user stopped the session's turn with Esc. Claude Code
 * fires no hook for an interrupt, so this ends its `Running` status.
 */
export function noteInterrupted(id: string): Promise<void> {
  if (!hasTauri()) {
    return Promise.resolve();
  }
  return invoke("note_interrupted", { id });
}

/**
 * Tell the backend the transcript recorded the session's turn ending (at
 * `endedMs`) while its status still says Running. It settles the status as
 * a missed `Stop` would have — if that end came after the newest prompt.
 */
export function noteTurnEnded(
  id: string,
  endedMs: number,
  interrupted: boolean
): Promise<void> {
  if (!hasTauri()) {
    return Promise.resolve();
  }
  return invoke("note_turn_ended", { endedMs, id, interrupted });
}

export function writeStdin(id: string, data: Uint8Array): Promise<void> {
  // Send the bytes as a raw request body (Tauri v2) rather than a JSON number
  // array. A number array inflates ~3.8x on the wire and forces an allocation
  // + integer parse on both sides — painful for large pastes. The session id
  // rides along in a header since the body is now the raw payload.
  return invoke("write_stdin", data, { headers: { "x-session-id": id } });
}

/**
 * Report bytes the frontend has drained from a session's PTY output, so the
 * backend reader can resume after parking at its high-water mark. Fire-and-
 * forget from the caller's perspective; the backend just advances a counter.
 */
export function reportDrained(id: string, bytes: number): Promise<void> {
  return invoke("report_drained", { id, bytes });
}

export function resizePty(
  id: string,
  cols: number,
  rows: number
): Promise<void> {
  return invoke("resize_pty", { id, cols, rows });
}

export function closeSession(id: string): Promise<void> {
  return invoke("close_session", { id });
}

/**
 * Write a session's seed [Handoff prompt] to a path-contained file and resolve
 * to its absolute path, so the launcher can start `claude "$(cat <path>)"`.
 */
export function seedPrompt(id: string, text: string): Promise<string> {
  return invoke("seed_prompt", { id, text });
}

// --- Transcript ---

export function watchTranscript(
  sessionId: string,
  onEvent: (e: StudioEvent) => void
): Promise<void> {
  if (!hasTauri()) {
    return Promise.resolve();
  }
  const channel = new Channel<StudioEvent>();
  channel.onmessage = (e) => onEvent(e);
  return invoke("watch_transcript", { sessionId, onEvent: channel });
}

/**
 * Subscribe to backend `session-status` events. Returns a promise resolving to
 * an unlisten function.
 */
export const onSessionStatus = subscribe<StatusUpdate>("session-status");

/**
 * A live [Session resources] sweep, emitted by the backend sampler every few
 * seconds: MB and CPU per live session plus the totals across all of them.
 */
export interface ResourcesUpdate {
  /** CPU percent (of one core) per session; absent until a second sample. */
  cpu: Record<string, number>;
  /** [Session footprint] in MB per session. */
  sessions: Record<string, number>;
  /** Whole-app CPU percent, or null until a second sample. */
  totalCpuPct: number | null;
  totalMb: number;
}

/**
 * Subscribe to backend `session-resources` events. Returns a promise resolving to
 * an unlisten function.
 */
export const onSessionResources =
  subscribe<ResourcesUpdate>("session-resources");

/**
 * Where a session sits in the [Sleeping session] lifecycle, as the backend
 * reports it. `stuck` is a session whose `claude` was stopped but which Kriyon
 * could not resume within the retry window — the user needs to know, rather
 * than watching a row stay moon-marked forever. `waking` is an in-flight wake:
 * the resume was typed but no `claude` is confirmed back yet, so the row shows
 * a spinner instead of a static moon while it loads.
 */
export type SleepPhase = "asleep" | "stuck" | "awake" | "waking";

/**
 * A [Sleeping session] phase as *stored* in the sessions map, where absence
 * means awake. Excluding `"awake"` keeps the invariant in the type: a store
 * that admitted `"awake"` would render a moon on an awake row, since the glyph
 * gate is a truthy check and `"awake"` is truthy.
 */
export type StoredSleepPhase = Exclude<SleepPhase, "awake">;

/** A [Sleeping session] transition emitted by the backend. */
export interface SleepingUpdate {
  sessionId: string;
  state: SleepPhase;
}

/**
 * Subscribe to backend `session-sleeping` events. Returns a promise resolving
 * to an unlisten function.
 */
export const onSessionSleeping = subscribe<SleepingUpdate>("session-sleeping");

/** The settings scope that turns Kriyon's hooks off for a session (mirrors
 *  Rust `HooksOff`), or `null` when they run. */
export interface HooksOffUpdate {
  scope: HooksOffScope | null;
  sessionId: string;
}

/**
 * Subscribe to backend `session-hooks-off` events, sent once per session
 * start. Returns a promise resolving to an unlisten function.
 */
export const onSessionHooksOff = subscribe<HooksOffUpdate>("session-hooks-off");

/** What the user agreed Kriyon adds to Claude Code (mirrors Rust `IntegrationPrefs`). */
export interface IntegrationPrefs {
  companion: boolean;
  consented: boolean;
  liveUsage: boolean;
  /** Kriyon's own finding; the backend ignores it from the UI. */
  sideloadRefused: boolean;
  statusHooks: boolean;
}

/** Where Kriyon's hooks are installed (mirrors Rust `HookRoute`). */
export type HookRoute = "plugin" | "settings" | "off";

/** Whether the org lets Kriyon side-load its companion folder. */
export type SideloadPolicy = "allowed" | "blocked" | "unknown";

/** The [Integration] as it stands (mirrors Rust `IntegrationStatus`). */
export interface IntegrationStatus {
  /** The companion can be turned on (it rides on the plugin route). */
  companionAvailable: boolean;
  companionDir: string | null;
  originalStatusLine: string | null;
  /** Why the hooks would be there once agreed to. */
  plannedReason: RouteReason;
  /** Where the hooks would go once agreed to (Rust decides; the UI never re-derives it). */
  plannedRoute: HookRoute;
  prefs: IntegrationPrefs;
  route: HookRoute;
  /** Why the hooks are where they are now. */
  routeReason: RouteReason;
  sideload: SideloadPolicy;
}

/** Why the hooks are on their route (mirrors Rust `RouteReason`). */
export type RouteReason =
  | "plugin"
  | "orgBlocks"
  | "policyUnknown"
  | "refused"
  | "off";

/**
 * What the welcome screen pre-checks before the backend answers — the prefs a
 * first run starts from, until `integration_status` replaces them.
 */
export const DEFAULT_INTEGRATION_PREFS: IntegrationPrefs = {
  companion: true,
  consented: false,
  liveUsage: true,
  sideloadRefused: false,
  statusHooks: true,
};

/**
 * The [Integration] as it stands. Outside the Tauri webview (browser QA) it
 * reads as already agreed, so the welcome screen never blocks a preview.
 */
export function integrationStatus(): Promise<IntegrationStatus> {
  if (!hasTauri()) {
    return Promise.resolve({
      companionDir: null,
      originalStatusLine: null,
      companionAvailable: true,
      plannedReason: "plugin",
      plannedRoute: "plugin",
      prefs: { ...DEFAULT_INTEGRATION_PREFS, consented: true },
      route: "plugin",
      routeReason: "plugin",
      sideload: "allowed",
    });
  }
  return invoke("integration_status");
}

/** Save and apply new prefs; consent is `consented: true`. */
export function integrationSet(
  prefs: IntegrationPrefs
): Promise<IntegrationStatus> {
  return invoke("integration_set", { prefs });
}

/**
 * Subscribe to `integration-refused`: Claude refused the companion folder
 * (the org forbids side-loading), and Kriyon moved its hooks to settings.
 */
export const onIntegrationRefused = subscribe<IntegrationStatus>(
  "integration-refused"
);

/** One session's companion, as the header chip shows it (mirrors Rust). */
export type CompanionState =
  | "off"
  | "blocked"
  | "needsRestart"
  | "starting"
  | "on"
  | "silent";

export interface CompanionStatus {
  claudeVersion: string | null;
  state: CompanionState;
}

/** One session's companion state. Off outside the Tauri webview. */
export function companionStatus(sessionId: string): Promise<CompanionStatus> {
  if (!hasTauri()) {
    return Promise.resolve({ claudeVersion: null, state: "off" });
  }
  return invoke("companion_status", { sessionId });
}

/** Subscribe to `companion-changed`: a session's companion posted something. */
export const onCompanionChanged = subscribe<{ sessionId: string }>(
  "companion-changed"
);

/** One thing Claude did in a turn (mirrors Rust `TurnItem`). */
export type TurnItem =
  | { kind: "text"; text: string }
  | {
      /** What Claude said the step is for, when the tool carries it (a
       *  command's or a subagent's `description`). */
      description: string | null;
      id: string;
      /** The input, capped: a long one is cut short and no longer parses. */
      input: string;
      isError: boolean;
      kind: "step";
      name: string;
      result: string | null;
      /** The same kind the Activity log gives the tool. */
      stepKind: StepKind;
      /** What the step acts on (a file's name, a pattern, a command's first
       *  line), read by Rust from the whole input. */
      target: string | null;
    }
  | { durationMs: number | null; kind: "thought" }
  | { kind: "compacted" };

/** What Claude Code tells the main agent when background work finishes,
 *  fails, stops or a monitor sees something (mirrors Rust `WorkReport`). */
export interface WorkReport {
  /** What a monitor saw, for an `event`. */
  event: string | null;
  outcome: "completed" | "failed" | "stopped" | "event" | "update";
  /** Claude Code's one-line summary: `Agent "Review" finished`. */
  summary: string;
}

/** One turn of the [Structured view] (mirrors Rust `StructuredTurn`). */
export interface StructuredTurn {
  did: TurnItem[];
  /** Claude Code recorded the turn's end (its `turn_duration` row). */
  ended: boolean;
  /** When the turn's newest row was written (ms since the epoch). */
  endedMs: number | null;
  /** Admitted paths of the prompt's images ({@link attachmentPreview}). */
  images: string[];
  /** The user pressed Esc during the turn. */
  interrupted: boolean;
  /** `null` for rows before the first prompt, and for a turn
   *  {@link WorkReport}s opened. */
  prompt: string | null;
  reply: string | null;
  /** The [Work report]s that woke Claude for this turn, in place of a prompt. */
  reports: WorkReport[];
  source: "live" | "transcript";
  /** When the prompt was sent (ms since the epoch). */
  startedMs: number | null;
}

/** Claude's reply as it streams (mirrors Rust `PartialReply`): the newest
 *  snapshot of one text block, until its row is kept. */
export interface PartialReply {
  block: number;
  done: boolean;
  receivedMs: number;
  step: number;
  text: string;
  turnId: string;
}

/** The session's reply as it streams, or `null` when nothing is. */
export function structuredPartial(
  sessionId: string
): Promise<PartialReply | null> {
  if (!hasTauri()) {
    return Promise.resolve(null);
  }
  return invoke("structured_partial", { sessionId });
}

/** A session's turns for the Structured view, oldest first. */
export function structuredTurns(sessionId: string): Promise<StructuredTurn[]> {
  if (!hasTauri()) {
    return Promise.resolve([]);
  }
  return invoke("structured_turns", { sessionId });
}

// --- Attachments (ADR-0037) ---

/** How an [Attachment] is sent: an image is pasted, the rest are `@` mentions. */
export type AttachmentKind = "image" | "file" | "folder";

/** One admitted [Attachment] (mirrors Rust `Attachment`). */
export interface Attachment {
  bytes: number;
  /** Why it may not reach Claude as meant, in plain words. */
  caution: string | null;
  /** The file the user chose, when this is a copy converted so Claude can
   *  see it (a HEIC photo made JPEG). */
  convertedFrom: string | null;
  kind: AttachmentKind;
  name: string;
  /** The admitted path — the only handle the backend accepts back. */
  path: string;
}

/** Open the native file picker; resolves to what the user chose. */
export function pickAttachments(): Promise<Attachment[]> {
  if (!hasTauri()) {
    return Promise.resolve([]);
  }
  return invoke("pick_attachments");
}

/** The files on the clipboard (copied in Finder), admitted. */
export function clipboardAttachments(): Promise<Attachment[]> {
  if (!hasTauri()) {
    return Promise.resolve([]);
  }
  return invoke("clipboard_attachments");
}

/** Save a pasted image's bytes (a screenshot) and admit it. */
export function savePastedImage(bytes: Uint8Array): Promise<Attachment> {
  return invoke("save_pasted_image", bytes);
}

/** An admitted image's bytes, for a thumbnail or a full view. */
export function attachmentPreview(path: string): Promise<ArrayBuffer> {
  return invoke("attachment_preview", { path });
}

/**
 * Send a message and its attachments to the session's terminal, the way the
 * CLI's input takes them, ending with Enter. Resolves once every key is in.
 */
export function submitPrompt(
  sessionId: string,
  text: string,
  attachments: string[]
): Promise<void> {
  return invoke("submit_prompt", { attachments, sessionId, text });
}

/** A drag of files over the main window (positions in physical pixels). */
export type AttachmentDrag =
  | { phase: "over"; x: number; y: number }
  | { attachments: Attachment[]; phase: "drop"; x: number; y: number }
  | { phase: "leave" };

export const onAttachmentDrag = subscribe<AttachmentDrag>("attachment-drag");

/** A live usage update emitted by the backend for one session. */
export interface UsageUpdate {
  sessionId: string;
  snapshot: UsageSnapshot;
}

/**
 * Subscribe to backend `session-usage` events (live token/context/cost from the
 * statusLine wrapper). Returns a promise resolving to an unlisten function.
 */
export const onSessionUsage = subscribe<UsageUpdate>("session-usage");

/**
 * The account's [Plan limits], emitted when they change and re-sent every
 * few seconds, so a late subscriber catches up without a separate read.
 */
export const onPlanLimits = subscribe<PlanLimits>("plan-limits");

/** A live activity update emitted by the backend for one session. */
export interface ActivityUpdate {
  sessionId: string;
  snapshot: SessionActivity;
}

/**
 * Subscribe to backend `session-activity` events (running subagents, background
 * shells, and the task list, reconstructed from the transcript). Returns a
 * promise resolving to an unlisten function.
 */
export const onSessionActivity = subscribe<ActivityUpdate>("session-activity");

/** A session-title update emitted by the backend (Claude's `ai-title`). */
export interface TitleUpdate {
  sessionId: string;
  title: string;
}

/**
 * Subscribe to backend `session-title` events: the human label Claude wrote for
 * the session, updated as it evolves. Returns a promise resolving to an unlisten
 * function.
 */
export const onSessionTitle = subscribe<TitleUpdate>("session-title");

/** A Claude-session-id update emitted by the backend (learned from hooks). */
export interface ClaudeIdUpdate {
  claudeSessionId: string;
  sessionId: string;
}

/**
 * Subscribe to backend `session-claude-id` events: Claude Code's own session id,
 * persisted so the session can be resumed. Returns a promise resolving to an
 * unlisten function.
 */
export const onSessionClaudeId = subscribe<ClaudeIdUpdate>("session-claude-id");

/** A [Handoff file] a session's turn just produced (validated in Rust). */
export interface HandoffReady {
  path: string;
  /** The [Handoff prompt] the new session starts with. */
  prompt?: string;
  sessionId: string;
}

/**
 * Subscribe to backend `session-handoff` events: a turn ended having written
 * a [Handoff file]. Returns a promise resolving to an unlisten function.
 */
export const onSessionHandoff = subscribe<HandoffReady>("session-handoff");

/** A session-ready signal: the (resumed) Claude has booted and is idle. */
export interface ReadyUpdate {
  sessionId: string;
}

/**
 * Subscribe to backend `session-ready` events, fired when the (resumed or
 * freshly started) Claude has emitted its first live `SessionStart` hook.
 * Returns a promise resolving to an unlisten function.
 */
export const onSessionReady = subscribe<ReadyUpdate>("session-ready");

/**
 * A session heartbeat: the backend's proof that a session's watcher is alive,
 * carrying the watcher's own last-pump wall-clock time. A watcher whose pump has
 * died keeps emitting heartbeats (via the global ticker) but with a frozen
 * `lastSeenMs`, so the command center can detect staleness honestly.
 */
export interface HeartbeatUpdate {
  lastSeenMs: number;
  sessionId: string;
}

/**
 * Subscribe to backend `session-heartbeat` events. Returns a promise resolving
 * to an unlisten function.
 */
export const onSessionHeartbeat =
  subscribe<HeartbeatUpdate>("session-heartbeat");

/**
 * Subscribe to backend `focus-session` events, emitted when the user clicks an
 * OS notification. Resolves to an unlisten fn. No-ops outside the Tauri webview.
 */
export function onFocusSession(
  cb: (sessionId: string) => void
): Promise<() => void> {
  return subscribe<{ sessionId: string }>("focus-session")((payload) =>
    cb(payload.sessionId)
  );
}

/**
 * Reveal (focus) a specific session's window from the tray popover, mirroring
 * `reveal_session` in the Task 4 Rust core.
 */
export function revealSession(sessionId: string): Promise<void> {
  return invoke("reveal_session", { sessionId });
}

/** Bring the main window to the front, unminimizing it if needed. */
export function showMainWindow(): Promise<void> {
  return invoke("show_main_window");
}

/** Ask the main window to open the Spawn dialog for a brand-new session. */
export function newSession(): Promise<void> {
  return invoke("new_session");
}

/** Ask the main window to open its preferences (the command palette). */
export function openPreferences(): Promise<void> {
  return invoke("open_preferences");
}

/**
 * "Sleep idle sessions now": put every quiescent session to sleep at once,
 * whatever the auto-sleep setting. Resolves to how many were told to stop — a
 * busy, on-screen or already-sleeping session is never counted. Resolves to 0
 * outside the Tauri webview (browser QA).
 */
export function sleepIdleSessions(): Promise<number> {
  if (!hasTauri()) {
    return Promise.resolve(0);
  }
  return invoke<number>("sleep_idle_sessions");
}

/**
 * The [Quit intent] a quit gesture may choose: stop every session, or stop all
 * but the ones mid-turn and let those finish under their daemons. (The third
 * intent, a handover, is the app's own — an update restart — never a gesture's.)
 */
export type QuitIntent = "stopAll";

/**
 * Quit the app — the same exit as the tray's "Quit Kriyon". Used by the window
 * close gate once it has decided the quit may proceed, carrying what the user
 * chose for the sessions still alive. Rust does the stopping on its way out —
 * the frontend only knows the panes it has mounted. No-ops outside the Tauri
 * webview (browser QA), where there is no app to exit.
 */
export function quitApp(intent: QuitIntent): Promise<void> {
  if (!hasTauri()) {
    return Promise.resolve();
  }
  return invoke("quit_app", { intent });
}

/**
 * Open a URL in the user's default browser via the OS opener. No-ops outside
 * the Tauri webview (browser QA) so an About-panel link click is harmless.
 */
export function openExternalUrl(url: string): Promise<void> {
  if (!hasTauri()) {
    return Promise.resolve();
  }
  return openUrl(url);
}

/**
 * Open a file referenced by Claude in the OS default app. `cwd` is the session's
 * working dir (used to resolve a relative `path`); the Rust `open_path` command
 * re-validates both and rejects a missing or non-openable file. No-ops outside
 * the Tauri webview (browser QA).
 */
export function openPath(
  cwd: string,
  path: string,
  allowOutside = false
): Promise<void> {
  if (!hasTauri()) {
    return Promise.resolve();
  }
  return invoke("open_path", { allowOutside, cwd, path, reveal: false });
}

/** Reveal a referenced file or directory in Finder (selects, does not open).
 * See {@link openPath}. */
export function revealPath(
  cwd: string,
  path: string,
  allowOutside = false
): Promise<void> {
  if (!hasTauri()) {
    return Promise.resolve();
  }
  return invoke("open_path", { allowOutside, cwd, path, reveal: true });
}

/**
 * Open a file in the user's code editor (Cursor, VS Code, a JetBrains IDE, …
 * — the first one installed), not the type-default app — so the Changes view's
 * "Open in editor" lands a file in a real editor instead of launching a
 * browser (`.html`) or a previewer (`.md`). Falls back to the OS text editor
 * when no code editor is installed. Same sandboxing/no-op-on-failure contract
 * as {@link openPath}.
 */
export function openInEditor(cwd: string, path: string): Promise<void> {
  if (!hasTauri()) {
    return Promise.resolve();
  }
  return invoke("open_in_editor", { cwd, path });
}

/**
 * Subscribe to backend `show-about` events, emitted when the macOS app menu's
 * "About Kriyon" item is chosen. Resolves to an unlisten fn. No-ops outside the
 * Tauri webview.
 */
export function onShowAbout(cb: () => void): Promise<() => void> {
  return subscribe<void>("show-about")(() => cb());
}

/**
 * Subscribe to backend `new-session` events, emitted when the tray's "New
 * session" row is clicked. Resolves to an unlisten fn. No-ops outside the
 * Tauri webview.
 */
export function onNewSession(cb: () => void): Promise<() => void> {
  return subscribe<void>("new-session")(() => cb());
}

/**
 * Subscribe to backend `open-preferences` events, emitted when the tray's
 * gear icon is clicked. Resolves to an unlisten fn. No-ops outside the Tauri
 * webview.
 */
export function onOpenPreferences(cb: () => void): Promise<() => void> {
  return subscribe<void>("open-preferences")(() => cb());
}

/**
 * Subscribe to backend `menu-bar-mode` events, broadcast by the main window
 * whenever the user changes the menu-bar popover layout, so a live tray
 * popover re-lays-out immediately. Resolves to an unlisten fn. No-ops outside
 * the Tauri webview.
 */
export const onMenuBarMode = subscribe<"compact" | "grouped">("menu-bar-mode");

/**
 * Subscribe to backend `menu-bar-theme` events, broadcast by the main window
 * whenever the user changes the active theme, so a live tray popover re-themes
 * immediately. Resolves to an unlisten fn. No-ops outside the Tauri webview.
 */
export const onMenuBarTheme = subscribe<string>("menu-bar-theme");

/**
 * Subscribe to the tray popover's visibility, broadcast by the backend from the
 * panel's *native* focus event (`tray-visibility`, `true` on show / `false` on
 * hide). The popover polls live session state only while visible instead of
 * hitting the backend every 2s for the app's whole lifetime.
 *
 * This deliberately does NOT use the webview's `onFocusChanged`: that JS focus
 * event does not fire reliably for this borderless panel (the same reason the
 * notification focus-gate lives in Rust), which left the popover polling once at
 * startup and never again. Resolves to an unlisten fn. No-ops outside Tauri.
 */
export const onTrayVisibility = subscribe<boolean>("tray-visibility");

/** A self-contained render row for the tray popover (mirrors Rust `SessionSnapshot`). */
export interface SessionSnapshotRow {
  branch: string | null;
  /** Latest [Session footprint] in MB, or null before the first sample. */
  memoryMb: number | null;
  /** Backend-decided "needs you" membership (waiting or an open ask), the single
   *  rule shared with the menu-bar badge count. See Rust `session_needs_you`. */
  needsYou: boolean;
  pendingAsk: PendingAsk | null;
  projectName: string;
  sessionId: string;
  status: SessionStatus;
  summary: string;
  title: string;
}

/** What the tray polls: the live rows plus the authoritative whole-app total. */
export interface TraySnapshot {
  sessions: SessionSnapshotRow[];
  /** Whole-app CPU percent from the same sweep, or null before two samples. */
  totalCpuPct: number | null;
  /**
   * Whole-app [Session footprint] in MB, as the backend computed it. Carried
   * rather than re-summed from `sessions`: the rows and the total come from
   * different backend maps, so a client-side sum can quietly disagree with the
   * number the [Memory budget] warning uses.
   */
  totalMemoryMb: number;
}

/**
 * Current live status + open ask for every tracked session, straight from the
 * backend's in-memory trackers (not the persisted rows, which are always idle).
 * The tray reads this on open so an already-running/waiting session shows its
 * real state instead of a stale idle. Empty outside the Tauri webview.
 */
export function sessionSnapshots(): Promise<TraySnapshot> {
  if (!hasTauri()) {
    return Promise.resolve({
      sessions: [],
      totalCpuPct: null,
      totalMemoryMb: 0,
    });
  }
  return invoke("session_snapshots");
}

// --- Git / worktrees ---

export function repoStatus(repoPath: string): Promise<RepoStatus> {
  return invoke("repo_status", { repoPath });
}

export function createWorktree(
  repoPath: string,
  branch: string,
  path: string
): Promise<void> {
  return invoke("create_worktree", { repoPath, branch, path });
}

/**
 * Remove a worktree. `force` discards uncommitted changes — only pass it after
 * the user explicitly confirmed that loss (git refuses a dirty tree otherwise).
 */
export function removeWorktree(
  repoPath: string,
  path: string,
  force = false
): Promise<void> {
  return invoke("remove_worktree", { repoPath, path, force });
}

/** Resolve the repo's default branch — the base a session diff compares against. */
export function defaultBranch(repoPath: string): Promise<string> {
  return invoke("default_branch", { repoPath });
}

/** Diff a worktree's committed changes against `base` (`<base>...HEAD`). */
export function diffWorktree(
  worktreePath: string,
  base: string
): Promise<SessionDiff> {
  return invoke("diff_worktree", { worktreePath, base });
}

/**
 * Diff the working tree (uncommitted changes, including untracked files)
 * against `base`, or `HEAD` when `base` is omitted. Backs the Code Changes
 * View: worktree sessions pass their merge-base branch, plain sessions pass
 * nothing.
 */
export function diffWorkingTree(
  cwd: string,
  base?: string
): Promise<SessionDiff> {
  return invoke("diff_working_tree", { cwd, base });
}

/**
 * Read a sandboxed file at `path` (relative to `cwd`) for the Code Changes
 * View's file preview pane. `cwd` must be a known session/project root; the
 * resolved path can never leave it (see Rust `sandbox::SandboxRoot::resolve`).
 */
export function readFile(cwd: string, path: string): Promise<FileContent> {
  return invoke("read_file", { cwd, path });
}

/**
 * The HEAD version of one file, as returned by {@link readBaseline} — a
 * discriminated union, because the three outcomes drive three different
 * gutters and any two of them collapsed together paints a wrong one:
 *
 * - `notARepo` — `cwd` isn't inside a git working tree, so there is no
 *   baseline at all and the gutter stays off.
 * - `untracked` — a repo, but this path has no HEAD blob yet (new file), so
 *   every line genuinely is added.
 * - `tracked` — a HEAD blob exists; `content: null` means it was too large,
 *   binary, or not UTF-8 to show, which also leaves the gutter off.
 *
 * Mirrors Rust `git_cmd::BaselineContent` (internally tagged on `state`).
 */
export type BaselineContent =
  | { state: "notARepo" }
  | { state: "untracked" }
  | { content: string | null; state: "tracked" };

/**
 * Read the HEAD version of a sandboxed file at `path` (relative to `cwd`) —
 * the editor gutter's diff baseline. Same sandboxing as {@link readFile}
 * (Rust `git_cmd::read_baseline`, reusing the same `sandbox::SandboxRoot`
 * the file commands take). See {@link BaselineContent} for the three outcomes.
 */
export function readBaseline(
  cwd: string,
  path: string
): Promise<BaselineContent> {
  return invoke("read_baseline", { cwd, path });
}

/**
 * Restore the sandboxed file at `path` (relative to `cwd`) to its HEAD
 * version, discarding every uncommitted change to it — Rust
 * `git_cmd::discard_file_changes`, `git checkout HEAD -- ./<path>` behind the
 * same sandbox {@link readFile} uses (with the `.git` refusal, since this one
 * writes).
 *
 * **Destructive and unrecoverable**: the discarded content exists nowhere
 * afterwards. Confirm with the user before calling this. Rejects for an
 * untracked file (no committed version to restore) rather than failing
 * obscurely inside git.
 */
export function discardFileChanges(cwd: string, path: string): Promise<void> {
  return invoke("discard_file_changes", { cwd, path });
}

/**
 * Create an empty file at `path` (relative to `cwd`) for the Code Changes
 * View's file browser. Same sandboxing as {@link readFile}, resolved through
 * the [New-entry sandbox] because the target does not exist yet.
 *
 * Rejects with `"already exists"` rather than truncating whatever is there.
 */
export function createFile(cwd: string, path: string): Promise<void> {
  return invoke("create_file", { cwd, path });
}

/**
 * Create one directory at `path` (relative to `cwd`). Same sandboxing as
 * {@link createFile}; the parent must already exist (one new name per call,
 * never a whole chain).
 */
export function createDir(cwd: string, path: string): Promise<void> {
  return invoke("create_dir", { cwd, path });
}

/**
 * Rename the entry at `path` (relative to `cwd`) to `newName`, in place.
 *
 * Same-directory only: `newName` is a single name, not a path, so a rename
 * cannot move an entry elsewhere. Rejects with `"already exists"` rather than
 * clobbering the target.
 */
export function renameEntry(
  cwd: string,
  path: string,
  newName: string
): Promise<void> {
  return invoke("rename_entry", { cwd, newName, path });
}

/**
 * Move the entry at `path` (relative to `cwd`) to the macOS Trash.
 *
 * **Destructive** — recoverable from Finder, not from inside Kriyon. Confirm
 * with the user before calling this. Deletes a directory with its contents.
 */
export function deleteEntry(cwd: string, path: string): Promise<void> {
  return invoke("delete_entry", { cwd, path });
}

/**
 * List the immediate children of `path` (relative to `cwd`) for the Code
 * Changes View's file browser. Same sandboxing as {@link readFile}.
 */
export function listDir(cwd: string, path: string): Promise<DirEntry[]> {
  return invoke("list_dir", { cwd, path });
}

/**
 * Save `content` over the sandboxed file at `path` (relative to `cwd`) for
 * the Code Changes View's file editor. Same sandboxing as {@link readFile},
 * plus: refuses `.git/`, refuses a target that's currently binary on disk,
 * and refuses to save if the file's on-disk `(mtime, len)` no longer matches
 * `expectedMtime`/`expectedLen` (i.e. it changed since it was last read) —
 * see Rust `file_cmd::write_file_sync`. On success, adopt the returned
 * `(mtime, len)` as the new expected signature for the file's next save.
 */
export function writeFile(
  cwd: string,
  path: string,
  content: string,
  expectedMtime: number,
  expectedLen: number
): Promise<FileWriteResult> {
  return invoke("write_file", {
    cwd,
    path,
    content,
    expectedMtime,
    expectedLen,
  });
}

/**
 * Capture a hook-free snapshot of `cwd`'s working tree as a dangling tree
 * object oid — the baseline a session's Changes view diffs against. Persist
 * the result on the session row (`baselineOid`) so it survives app restart.
 */
export function captureBaseline(cwd: string): Promise<string> {
  return invoke("capture_baseline", { cwd });
}

/**
 * Diff a session's working-tree changes against its `baselineOid` (from
 * {@link captureBaseline}), rather than against a committed ref. Catches
 * edits made by any means and self-corrects when a file is reverted.
 */
export function diffSessionChanges(
  cwd: string,
  baselineOid: string
): Promise<SessionDiff> {
  return invoke("diff_session_changes", { cwd, baselineOid });
}

/** Resolve `cwd`'s git repo toplevel (`git rev-parse --show-toplevel`). */
export function repoToplevel(cwd: string): Promise<string> {
  return invoke("repo_toplevel", { cwd });
}

/**
 * Start (or join) the [Working-tree watch] on the repo containing `cwd`, held
 * open for `sessionId`, resolving to the watched repo root — the same value
 * the `working-tree-changed` payload carries, so a caller can match events
 * back to sessions. Idempotent per session.
 */
export function watchWorkingTree(
  sessionId: string,
  cwd: string
): Promise<string> {
  return invoke("watch_working_tree", { cwd, sessionId });
}

/** Drop `sessionId`'s hold on its [Working-tree watch] (see {@link watchWorkingTree}). */
export function unwatchWorkingTree(sessionId: string): Promise<void> {
  return invoke("unwatch_working_tree", { sessionId });
}

/** A working-tree change emitted by the backend, naming the repo that moved. */
export interface TreeChangedUpdate {
  repoRoot: string;
}

/**
 * Subscribe to backend `working-tree-changed` events: a settled burst of real
 * file changes under a watched repo, whoever made them (Claude's tools, the
 * user's own save, an external editor, `git checkout`). Per *repo*, not per
 * session — several sessions commonly share one checkout. Returns a promise
 * resolving to an unlisten function.
 */
export const onWorkingTreeChanged = subscribe<TreeChangedUpdate>(
  "working-tree-changed"
);

/** Merge `branch` into the repo's base checkout, surfacing conflicts read-only. */
export function mergeWorktree(
  repoPath: string,
  branch: string
): Promise<MergeOutcome> {
  return invoke("merge_worktree", { repoPath, branch });
}

/** The canonical sibling worktree path for `branch` (mirrors Rust `worktree_path_for`). */
export function worktreePathFor(
  repoPath: string,
  branch: string
): Promise<string> {
  return invoke("worktree_path", { repoPath, branch });
}

/** One step of a {@link BootstrapReport} (mirrors Rust `BootstrapStep`). */
export interface BootstrapStep {
  label: string;
  ok: boolean;
}

/** Outcome of a worktree bootstrap (mirrors Rust `BootstrapReport`). */
export interface BootstrapReport {
  ok: boolean;
  output: string;
  steps: BootstrapStep[];
}

/** Copy `.env*`, install deps, and run the project's setup command in a fresh worktree. */
export function bootstrapWorktree(
  repoPath: string,
  worktreePath: string,
  setupCmd: string | null
): Promise<BootstrapReport> {
  return invoke("bootstrap_worktree", { repoPath, worktreePath, setupCmd });
}

// --- Persistence ---

export function saveLayout(key: string, valueJson: string): Promise<void> {
  return invoke("save_layout", { key, valueJson });
}

export function loadLayout(key: string): Promise<string | null> {
  return invoke("load_layout", { key });
}

export function upsertProject(project: ProjectRow): Promise<void> {
  return invoke("upsert_project", { project });
}

export function listProjects(): Promise<ProjectRow[]> {
  return invoke("list_projects");
}

export function upsertSession(session: SessionRow): Promise<void> {
  return invoke("upsert_session", { session });
}

export function listSessions(): Promise<SessionRow[]> {
  return invoke("list_sessions");
}

export function listPastSessions(
  cwd: string,
  limit: number
): Promise<PastSessionPage> {
  return invoke("list_past_sessions", { cwd, limit });
}

export function deleteSession(id: string): Promise<void> {
  return invoke("delete_session", { id });
}

export function upsertPrompt(prompt: SavedPrompt): Promise<void> {
  return invoke("upsert_prompt", { prompt });
}

export function listPrompts(): Promise<SavedPrompt[]> {
  return invoke("list_prompts");
}

export function deletePrompt(id: string): Promise<void> {
  return invoke("delete_prompt", { id });
}

/** Bump a prompt's use count / last-used time (backend stamps the clock). */
export function recordPromptUse(id: string): Promise<void> {
  return invoke("record_prompt_use", { id });
}

/**
 * Read the OS clipboard's plain text from the Rust core. Fixes `{clipboard}`:
 * `navigator.clipboard.readText()` rejects in the packaged WKWebView.
 */
export function readClipboard(): Promise<string> {
  return invoke("read_clipboard");
}

/** One `.claude/commands/*.md` file parsed for import (mirrors Rust ImportedCommand). */
export interface ImportedCommand {
  body: string;
  description: string | null;
  name: string;
}

/**
 * [Promote] a saved prompt to a `.claude/commands/<name>.md` slash command.
 * `projectId = null` targets the global `~/.claude/commands`. Resolves to the
 * written file's absolute path.
 */
export function promotePromptToCommand(
  projectId: string | null,
  name: string,
  description: string,
  body: string,
  overwrite: boolean
): Promise<string> {
  return invoke("promote_prompt_to_command", {
    body,
    description,
    name,
    overwrite,
    projectId,
  });
}

/** Read a scope's `.claude/commands/*.md` files for import into the library. */
export function importCommands(
  projectId: string | null
): Promise<ImportedCommand[]> {
  return invoke("import_commands", { projectId });
}

/**
 * Tell the backend which session the user is currently focused on, or `null`
 * when nothing is active / the window is blurred. Drives OS-notification
 * suppression for the focused session.
 */
export function setFocusedSession(id: string | null): Promise<void> {
  return invoke("set_focused_session", { id });
}

/**
 * Set the cross-project OS-notification preference. Layered on top of the
 * per-transition notify decision so the user can mute everything, or only be
 * told about sessions blocked on input, across every project.
 */
export function setNotifyPreference(pref: NotifyPreference): Promise<void> {
  return invoke("set_notify_preference", { pref });
}

/** Set the chosen OS-notification sound (attached to future notifications). */
export function setNotifySound(sound: NotifySound): Promise<void> {
  return invoke("set_notify_sound", { sound });
}

/** Play the given notification sound once, for previewing it in Settings. */
export function previewNotifySound(sound: NotifySound): Promise<void> {
  return invoke("preview_notify_sound", { sound });
}

/**
 * Push the [Memory budget] to the backend: the whole-app footprint (MB) above
 * which it warns, and whether the warning fires at all.
 */
export function setMemoryBudget(
  budgetMb: number,
  warnEnabled: boolean
): Promise<void> {
  return invoke("set_memory_budget", { budgetMb, warnEnabled });
}

/**
 * Push the [Sleeping session] auto-sleep policy to the backend: whether
 * long-idle sessions get their `claude` stopped, and after how many seconds.
 */
export function setAutoSleep(
  enabled: boolean,
  afterSecs: number
): Promise<void> {
  return invoke("set_auto_sleep", { enabled, afterSecs });
}

/** Resolve the user's home directory as an absolute path string. */
export function homeDir(): Promise<string> {
  return invoke<string>("home_dir");
}

/**
 * Open the native folder picker and resolve to the chosen absolute path, or
 * `null` if the user cancels (or there is no Tauri runtime). Used to choose the
 * working directory for a new session.
 */
export async function pickDirectory(): Promise<string | null> {
  if (!hasTauri()) {
    return null;
  }
  const { open } = await import("@tauri-apps/plugin-dialog");
  const selected = await open({ directory: true, multiple: false });
  return typeof selected === "string" ? selected : null;
}

// --- Composer completions ---

/** One slash command in the live catalog (mirrors Rust `SlashCommand`). */
export type CommandSource = "builtin" | "custom";
export interface SlashCommand {
  argumentHint: string | null;
  description: string | null;
  name: string;
  source: CommandSource;
}

/** The composer's live command catalog (mirrors Rust `CommandCatalog`). */
export interface CommandCatalog {
  agents: string[];
  claudeVersion: string | null;
  commands: SlashCommand[];
  degraded: boolean;
}

/** A `@`-mention file candidate (mirrors Rust `FileEntry`). */
export interface FileEntry {
  isDir: boolean;
  path: string;
}

/** The [Prompt history] of a session's folder, newest first: every prompt
 *  the CLI took there, from the terminal or the composer. */
export function promptHistory(cwd: string): Promise<string[]> {
  if (!hasTauri()) {
    return Promise.resolve([]);
  }
  return invoke("prompt_history", { cwd });
}

/** Probe the installed `claude` CLI for its live slash-command catalog. */
export function listSlashCommands(cwd: string): Promise<CommandCatalog> {
  return invoke("list_slash_commands", { cwd });
}

/** Filesystem completions for `@` mentions under `cwd`, filtered by `query`. */
export function listFiles(cwd: string, query: string): Promise<FileEntry[]> {
  return invoke("list_files", { cwd, query });
}

// --- Activity log (mirrors Rust `activity_store`) ---

/** What kind of tool an [Activity step] ran (Rust `StepKind`). */
export type StepKind =
  | "read"
  | "search"
  | "edit"
  | "write"
  | "command"
  | "web"
  | "agent"
  | "mcp"
  | "other";

/** Where an [Activity step] stands (Rust `StepStatus`). */
export type StepStatus = "running" | "ok" | "error";

/** One [Activity step] as a timeline row shows it. */
export interface ActivityStep {
  /** Main agent when `null`; otherwise the subagent's type. */
  agentType: string | null;
  durationMs: number | null;
  /** A bit set of [Step flags] — see `STEP_FLAGS` in the Activity tab. */
  flags: number;
  id: number;
  kind: StepKind;
  startedMs: number;
  status: StepStatus;
  target: string | null;
  toolName: string;
}

/** One turn of the [Activity log]: a prompt and the steps it led to. */
export interface ActivityTurn {
  endedMs: number | null;
  endReason: string | null;
  id: number;
  prompt: string | null;
  /** Who sent the prompt (`user`, `system`, `loop_wakeup`, …), when known. */
  source: string | null;
  startedMs: number;
  steps: ActivityStep[];
}

/** Everything about one step, for its detail dialog. */
export interface ActivityStepDetail extends ActivityStep {
  agentId: string | null;
  allowedBy: string;
  endedMs: number | null;
  /** The redacted tool input — usually JSON. */
  input: string | null;
  result: string | null;
}

/**
 * The retention shown when the backend can't say (outside Tauri, or a failed
 * stats read). Rust's `RETENTION_DAYS` is the source of truth; this only keeps
 * the copy honest until it answers.
 */
export const FALLBACK_RETENTION_DAYS = 30;

/** The [Activity store]'s size and reach. */
export interface ActivityStats {
  retentionDays: number;
  sessions: number;
  sizeBytes: number;
  sizeCapBytes: number;
}

/** A session's [Activity log] gained lines. */
export interface ActivityChangedUpdate {
  sessionId: string;
}

/** Subscribe to `activity-changed`: new lines were ingested for a session. */
export const onActivityChanged =
  subscribe<ActivityChangedUpdate>("activity-changed");

/** A session's newest turns, newest first. */
export function activityTurns(
  sessionId: string,
  limit?: number
): Promise<ActivityTurn[]> {
  if (!hasTauri()) {
    return Promise.resolve([]);
  }
  return invoke("activity_turns", { limit, sessionId });
}

/** One step in full, or `null` once it has been pruned. */
export function activityStep(
  sessionId: string,
  stepId: number
): Promise<ActivityStepDetail | null> {
  if (!hasTauri()) {
    return Promise.resolve(null);
  }
  return invoke("activity_step", { sessionId, stepId });
}

/** The store's size and retention; an empty store outside Tauri. */
export function activityStats(): Promise<ActivityStats> {
  if (!hasTauri()) {
    return Promise.resolve({
      retentionDays: FALLBACK_RETENTION_DAYS,
      sessions: 0,
      sizeBytes: 0,
      sizeCapBytes: 0,
    });
  }
  return invoke("activity_stats");
}

/** Forget everything Kriyon logged for one session. */
export function activityDeleteSession(sessionId: string): Promise<void> {
  if (!hasTauri()) {
    return Promise.resolve();
  }
  return invoke("activity_delete_session", { sessionId });
}

/** Delete every session's activity log (Settings). */
export function activityDeleteAll(): Promise<void> {
  if (!hasTauri()) {
    return Promise.resolve();
  }
  return invoke("activity_delete_all");
}

/** Which builds this Kriyon updates to (mirrors Rust `UpdateChannel`). */
export type UpdateChannel = "stable" | "beta" | "nightly";

/** The user's update settings, kept by Rust (mirrors Rust `UpdatePrefs`). */
export interface UpdatePrefs {
  autoCheck: boolean;
  channel: UpdateChannel;
  /** The [Skipped version], if any. */
  skipped: string | null;
}

/**
 * What a feed's version means for the running build (mirrors Rust `Offer`):
 * a newer version, a [Channel step-down], or a step-down that must wait.
 */
export type UpdateOffer = "nothing" | "upgrade" | "stepDown" | "waitForChannel";

/** A release the feed offers (mirrors Rust `AvailableUpdate`). */
export interface AvailableUpdate {
  /** Whether "Install & restart" can install it. Rust decides. */
  installable: boolean;
  /** Release notes, Markdown. */
  notes: string | null;
  offer: UpdateOffer;
  version: string;
}

/** Everything the updater knows (mirrors Rust `UpdateSnapshot`). */
export interface UpdateSnapshot {
  available: AvailableUpdate | null;
  checking: boolean;
  error: string | null;
  lastCheckedMs: number | null;
  prefs: UpdatePrefs;
  running: string;
  /** Only release builds can update themselves. */
  supported: boolean;
}

/** Download progress while an update installs (mirrors Rust `DownloadProgress`). */
export interface DownloadProgress {
  downloaded: number;
  total: number | null;
}

/** The updater's state. Outside the Tauri webview it reads as unsupported. */
export function updateStatus(): Promise<UpdateSnapshot> {
  if (!hasTauri()) {
    return Promise.resolve({
      available: null,
      checking: false,
      error: null,
      lastCheckedMs: null,
      prefs: { autoCheck: true, channel: "stable", skipped: null },
      running: "0.0.0",
      supported: false,
    });
  }
  return invoke("update_status");
}

/** "Check now": an asked check, which also shows a skipped version. */
export function checkForUpdate(): Promise<UpdateSnapshot> {
  return invoke("check_for_update");
}

/** Save the channel and auto-check; a new channel is checked straight away. */
export function setUpdatePrefs(
  channel: UpdateChannel,
  autoCheck: boolean
): Promise<UpdateSnapshot> {
  return invoke("set_update_prefs", { channel, autoCheck });
}

/** "Skip this version" for the version on offer. */
export function skipUpdate(version: string): Promise<UpdateSnapshot> {
  return invoke("skip_update", { version });
}

/**
 * "Install & restart" for the version on offer. Progress arrives on
 * `onProgress`; on success the app restarts, so the promise only settles on
 * failure.
 */
export function installUpdate(
  onProgress: (progress: DownloadProgress) => void
): Promise<void> {
  const channel = new Channel<DownloadProgress>();
  channel.onmessage = onProgress;
  return invoke("install_update", { onProgress: channel });
}

/** Subscribe to `update-changed`: the updater's state, whole, on every change. */
export const onUpdateChanged = subscribe<UpdateSnapshot>("update-changed");

/**
 * Subscribe to `update-channel-answered`: the first result for the feed the
 * user just moved to. It opens the switch prompt.
 */
export const onUpdateChannelAnswered = subscribe<UpdateSnapshot>(
  "update-channel-answered"
);
