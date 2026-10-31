export type SessionStatus = "idle" | "running" | "waiting" | "done" | "error";

/** The settings scope whose `disableAllHooks` / `allowManagedHooksOnly` turns
 *  Kriyon's hooks off for a session — [Hooks off] (mirrors Rust `HooksOff`). */
export type HooksOffScope = "managed" | "local" | "project" | "user" | "kriyon";

/**
 * The vocabulary the command center renders for a {@link SessionStanding}
 * (mirrors the reconciliation in CONTEXT.md). A presentation of
 * {@link SessionStatus} plus the `unknown` liveness overlay: `running→running`,
 * `waiting→awaiting_input`, `done`/`error`→`changed`, `idle→idle`, and
 * `unknown` when the watcher has gone stale.
 */
export type StandingState =
  | "running"
  | "awaiting_input"
  | "changed"
  | "idle"
  | "unknown";

/**
 * One session's entry in the command center: a flat, cheap-to-diff record
 * derived (never stored) from the live session store and watcher liveness.
 */
export interface SessionStanding {
  /** When the session's status last changed (drives recency ordering). */
  lastChangeMs: number;
  /** When the watcher was last seen alive; drives `unknown` when it lags. */
  lastSeenMs: number;
  projectId: string;
  sessionId: string;
  state: StandingState;
  worktree: string | null;
}

/**
 * The user's cross-project OS-notification policy (mirrors Rust
 * `NotifyPreference`, serde snake_case). `only_blocked` notifies only sessions
 * waiting on input; `none` mutes everything.
 */
export type NotifyPreference = "all" | "only_blocked" | "none";

/**
 * The user's chosen OS-notification sound (mirrors Rust `NotifySound`, serde
 * snake_case). `default` is the system alert; `silent` posts a banner with no
 * sound; the rest name a bundled `.wav`.
 */
export type NotifySound =
  | "default"
  | "silent"
  | "marimba"
  | "music_box"
  | "vibraphone"
  | "kalimba"
  | "bell";

/** One [Plan limits] window. Mirrors Rust `LimitWindow`. */
export interface LimitWindow {
  /** Unix epoch seconds. */
  resetsAt: number;
  /** 0-100. */
  usedPercentage: number;
}

/**
 * [Plan limits]: the account's 5-hour and weekly use, as Claude Code reports
 * it. A window is null when nothing has reported it or it has reset.
 */
export interface PlanLimits {
  fiveHour: LimitWindow | null;
  sevenDay: LimitWindow | null;
}

/**
 * A live usage snapshot captured from Claude Code's statusLine JSON — the
 * only exact source of the context-window fill. All fields optional; Claude
 * may omit any. `inputTokens` is what is in the context window now, not a
 * session total.
 */
export interface UsageSnapshot {
  contextWindowSize: number | null;
  inputTokens: number | null;
  model: string | null;
  outputTokens: number | null;
  /**
   * Claude's own session id for the main interactive agent, from the status-line
   * JSON. Used by the backend to anchor session status; the frontend ignores it.
   */
  sessionId: string | null;
  usedPercentage: number | null;
}

/** A persisted project (mirrors Rust `ProjectRow`). */
export interface ProjectRow {
  color: string | null;
  id: string;
  name: string;
  /** When the project was parked (ms since epoch), or null while it is on the
   *  rail (mirrors Rust `parked_at`). See [Parked project]. */
  parkedAt: number | null;
  path: string;
  /** Optional per-worktree setup command (mirrors Rust `setup_command`). */
  setupCommand: string | null;
}

/**
 * A session discovered from a folder's on-disk Claude history that Kriyon does
 * not yet track (mirrors Rust `PastSession`). Ephemeral — never persisted until
 * the user resumes it. Fields are flattened from the Rust summary via serde.
 */
export interface PastSession {
  claudeSessionId: string;
  cwd: string | null;
  gitBranch: string | null;
  lastActiveMs: number;
  messageCount: number;
  preview: string | null;
  title: string | null;
  version: string | null;
}

/** A page of past sessions plus the total available (mirrors `PastSessionPage`). */
export interface PastSessionPage {
  items: PastSession[];
  total: number;
}

/**
 * Where a [Nested session] sends its first answer: the Claude session id of
 * the session that started it (`to`), and the id its own conversation is
 * started with (`from`), so only that conversation reports (ADR-0049).
 */
export interface NestedReport {
  from: string;
  /** The person started it with [Split off], so the lead didn't ask for it. */
  splitOff?: boolean;
  to: string;
}

/** Who wanted a [Nested session] started (mirrors Rust `nested::Initiation`). */
export type NestedInitiation = "user_asked" | "own_initiative";

/** One validated request to start a [Nested session] (mirrors Rust
 *  `nested::SessionRequest`). */
export interface SessionRequest {
  branch: string | null;
  initiation: NestedInitiation;
  prompt: string;
  requestId: string;
  title: string;
  worktree: boolean;
}

/** A request with the session that asked (mirrors Rust `NestedRequest`). */
export interface NestedRequest {
  leadSessionId: string;
  request: SessionRequest;
}

/** What Kriyon does with a request (mirrors Rust `nested::Outcome`). */
export type NestedOutcome = "start" | "propose";

/** A persisted session (mirrors Rust `SessionRow`). */
export interface SessionRow {
  /** When the session was archived (ms since epoch), or null while active. */
  archivedAt: number | null;
  /**
   * The git oid captured at session start (see `captureBaseline`), used as the
   * base of the working-tree diff for the Changes view. `null` until a
   * baseline has been captured, or when the session's cwd is not a git repo.
   */
  baselineOid: string | null;
  /**
   * Claude Code's own session id, learned from hook events and persisted so the
   * session can be resumed with `claude --resume`. `null` until Claude reports it.
   */
  claudeSessionId: string | null;
  createdAt: number;
  cwd: string;
  id: string;
  /** The session this [Nested session] was started from, or null/absent for
   *  a top-level one (mirrors Rust `nested_under`, ADR-0049). */
  nestedUnder?: string | null;
  /** The [Handoff link]: the session this [Follow-up session] was spawned
   *  from, or null/absent for an ordinary session. Display only. */
  parentSessionId?: string | null;
  projectId: string;
  title: string;
  /** The user renamed this session by hand; Claude's `ai-title` must not
   *  overwrite it (mirrors Rust `title_locked`). */
  titleLocked: boolean;
  worktreePath: string | null;
}

/** A [Saved prompt] in the user's global prompt library (mirrors Rust PromptRow). */
export interface SavedPrompt {
  body: string;
  createdMs: number;
  favourite: boolean;
  id: string;
  lastUsedMs: number | null;
  tags: string[];
  title: string;
  updatedMs: number;
  useCount: number;
}

/** Repository status summary (mirrors Rust `kriyon_core::git::RepoStatus`). */
export interface RepoStatus {
  ahead: number;
  behind: number;
  branch: string;
  dirtyCount: number;
}

/** A single line within a diff hunk (mirrors Rust `DiffLine`). */
export interface DiffLine {
  kind: "added" | "removed" | "context";
  text: string;
}

/** How a file changed (mirrors Rust `FileChange`). */
export type FileChange = "added" | "modified" | "deleted" | "renamed";

/** One `@@ … @@` region of a file diff (mirrors Rust `DiffHunk`). */
export interface DiffHunk {
  header: string;
  lines: DiffLine[];
}

/** One file's change within a session diff (mirrors Rust `FileDiff`). */
export interface FileDiff {
  binary: boolean;
  hunks: DiffHunk[];
  oldPath: string | null;
  path: string;
  status: FileChange;
}

/** Why a [Working-tree budget] refused the untracked half of a diff, and what
 * to gitignore to get it back (mirrors Rust `BudgetExceeded`). */
export interface BudgetExceeded {
  /** The ceiling that was passed. */
  fileLimit: number;
  /** The wholly-untracked directories git collapsed the tree into — the
   * actionable part. A capped prefix of git's sorted listing, NOT ranked by
   * size (ranking would mean walking the tree that was too big to walk), so
   * never present these as "the biggest offenders". Possibly empty. */
  untrackedDirs: string[];
  /** Untracked paths counted before the walk stopped. A lower bound, not a
   * census: the enumeration stops as soon as it knows the ceiling is passed,
   * so this reads as "at least this many". */
  untrackedFiles: number;
}

/** One computed set of a session's changes vs some base — committed work on a
 * branch, uncommitted work in the working tree, or work since the session's
 * baseline snapshot (mirrors Rust `SessionDiff`). */
export interface SessionDiff {
  base: string;
  /**
   * Short sha `base` resolved to at diff time (e.g. `git rev-parse --short
   * <base>`), for a trustworthy baseline label. `null`/absent when
   * resolution wasn't attempted or failed.
   */
  baseSha?: string | null;
  /** Set when the [Working-tree budget]'s file ceiling was passed: `files`
   * holds this repo's tracked changes only, the untracked pass was skipped.
   * Absent on every ordinary diff. */
  budgetExceeded?: BudgetExceeded | null;
  files: FileDiff[];
  /** Untracked files enumerated but carrying no content — binary, over the
   * per-file cap, or past the budget's byte ceiling. Reported so a review
   * surface never claims completeness it doesn't have. */
  omittedUntracked?: number;
}

/** Result of merging a branch into base (mirrors Rust `MergeOutcome`). */
export type MergeOutcome =
  | { kind: "clean" }
  | { files: string[]; kind: "conflicted" };

/** Aggregate counts across all files/hunks in a {@link SessionDiff} (mirrors Rust `DiffTotals`). */
export interface DiffTotals {
  additions: number;
  deletions: number;
  files: number;
}

/**
 * A file's content as returned by `read_file`, for the Code Changes View's
 * file preview pane (mirrors Rust `FileContent`).
 */
export interface FileContent {
  binary: boolean;
  content: string;
  /** The on-disk bytes were not valid UTF-8, so `content` is a lossy
   * rendering shown read-only (like `truncated`): the file viewer must never
   * open an editor over it, because saving the lossy string back would
   * corrupt the original bytes and the `(mtime, len)` conflict guard can't
   * catch it. */
  lossy: boolean;
  mtime: number;
  size: number;
  truncated: boolean;
}

/** One entry in a `list_dir` listing (mirrors Rust `DirEntry`). */
export interface DirEntry {
  ignored: boolean;
  isDir: boolean;
  name: string;
}

/**
 * The new `(mtime, len)` signature of a file after a successful `write_file`
 * (mirrors Rust `FileWriteResult`). Adopt these as the "last known good"
 * values for the file's *next* save — see `bridge.writeFile`.
 */
export interface FileWriteResult {
  len: number;
  mtime: number;
}

/** A selectable answer for a {@link QuestionItem} (mirrors Rust `QuestionOption`). */
export interface QuestionOption {
  description: string;
  label: string;
}

/** One question in a {@link StructuredEvent} `question` event (mirrors Rust `QuestionItem`). */
export interface QuestionItem {
  header: string;
  multiSelect: boolean;
  options: QuestionOption[];
  question: string;
}

/**
 * A structured transcript event (mirrors Rust `StructuredEvent`, serde
 * `tag = "kind"`, snake_case kinds, camelCase fields).
 */
export type StructuredEvent =
  | { kind: "prompt"; text: string }
  | { kind: "assistant"; text: string }
  | { kind: "tool"; name: string; target: string | null; meta: string | null }
  | { kind: "bash"; cmd: string; output: string[]; exit: number | null }
  | {
      kind: "diff";
      file: string;
      additions: number;
      deletions: number;
      hunk: string;
      lines: DiffLine[];
    }
  | { kind: "code"; lang: string; file: string | null; lines: string[] }
  | { kind: "question"; questions: QuestionItem[] }
  | { kind: "unknown"; raw: string };

/**
 * A {@link StructuredEvent} tagged with a stable `id`
 * (`<transcript-line-uuid>:<block-index>`, mirrors Rust `StudioEvent`). The
 * store dedupes by `id`, so re-tailing the transcript on `claude --resume`
 * never stacks duplicates.
 */
export type StudioEvent = StructuredEvent & { id: string };

// --- Session activity (mirrors Rust `kriyon_core::activity`) ---

/** Lifecycle of a {@link Subagent}. */
export type SubagentState = "running" | "done";

/** Best-effort status of a {@link BackgroundShell} (see ADR 0002). */
export type ShellStatus = "running" | "exited" | "killed" | "unknown";

/** Status of a {@link Task}. */
export type TaskStatus = "pending" | "in_progress" | "completed";

/** One tool an agent (main or subagent) is currently running. */
export interface ToolActivity {
  startedAt: string | null;
  target: string | null;
  toolName: string;
}

/** The top-level agent's in-flight tool, if any. */
export interface MainAgent {
  currentTool: ToolActivity | null;
}

/** A nested agent the session spawned via Claude Code's Agent tool. */
export interface Subagent {
  agentId: string | null;
  currentTool: ToolActivity | null;
  description: string | null;
  durationMs: number | null;
  endedAt: string | null;
  kind: string;
  result: string | null;
  startedAt: string | null;
  state: SubagentState;
  toolUseId: string;
}

/** A Bash command launched with `run_in_background`, tracked by its bashId. */
export interface BackgroundShell {
  bashId: string;
  cmd: string;
  exit: number | null;
  lastPolledAt: string | null;
  status: ShellStatus;
}

/** One item in the session's checklist (TodoWrite / TaskCreate entry). */
export interface Task {
  activeForm: string | null;
  status: TaskStatus;
  text: string;
}

/** What kind of thing a waiting session is asking for (mirrors Rust `AskKind`). */
export type PendingAskKind = "question" | "permission" | "plan_approval";

/**
 * The concrete thing a waiting session wants from the user right now (mirrors
 * Rust `kriyon_core::ask::PendingAsk`). Ephemeral — rides the activity snapshot.
 */
export interface PendingAsk {
  /** ISO timestamp of the hook that opened the ask; drives "blocked for 12m". */
  askedAt: string | null;
  kind: PendingAskKind;
  text: string;
}

/**
 * The live, derived activity of a session: running subagents, background
 * shells, and the current task list. A projection of the transcript.
 */
export interface SessionActivity {
  main: MainAgent;
  /** The open Pending ask, or null. Exact-tier; the snippet fallback is derived. */
  pendingAsk: PendingAsk | null;
  shells: BackgroundShell[];
  subagents: Subagent[];
  tasks: Task[];
}
