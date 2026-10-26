import {
  closeSession as closeSessionIpc,
  createSession,
  reportDrained,
  requestRepaint,
  seedPrompt,
  writeStdin,
} from "../ipc/bridge.ts";
import type { NestedReport } from "../types.ts";

function ignore(promise: Promise<unknown>): void {
  promise.catch(() => {
    // Intentionally ignore IPC errors for fire-and-forget calls.
  });
}

/**
 * A Claude session id is safe to interpolate into the launch command only if it
 * is a bare token (Claude emits UUIDs). Persisted values cross back through the
 * store, so we re-validate before building a shell command from one.
 */
const SAFE_CLAUDE_ID = /^[A-Za-z0-9][\w-]{0,127}$/;

/**
 * Owns the lifecycle of each pty-backed session, keyed by session id, so it is
 * decoupled from React component mounts. A `Terminal` component only *attaches*
 * its xterm instance to a session's output stream and detaches on unmount; it
 * never creates or closes the pty.
 *
 * Why this exists: React StrictMode (and any remount) runs an effect as
 * setup → cleanup → setup. When the pty was created/closed inside that effect,
 * the throwaway first mount's cleanup — and its late-resolving `createSession`
 * promise — would `closeSession(id)` the *same* id the second mount just
 * recreated, racing the pty to death. Making create/close idempotent and
 * mount-independent removes that whole class of bug. The pty is created once
 * per id (here) and closed once, explicitly, when the session is removed from
 * the store (see {@link disposeSession}).
 */

type Sink = (bytes: Uint8Array) => void;

interface Host {
  /**
   * Resume-failure watchdog. Armed only when this session was launched with
   * `claude --resume <id>`; a resume whose conversation has expired makes Claude
   * print an error and exit without ever firing `SessionStart`. We detect that
   * (so the UI can offer "start fresh") from two signals — whichever comes first:
   * Claude's process exiting after it started ({@link Host.resumeSawBusy}), or a
   * {@link RESUME_TIMEOUT_MS} timeout. A real `SessionStart`
   * ({@link noteSessionStarted}) disarms it, so a slow-but-fine resume never trips.
   */
  awaitingResume: boolean;
  /**
   * Whether the session died underneath the app — the shell exited or the
   * daemon crashed (reported once by the backend's exit channel). An exited
   * host is kept, like a failed one, so the next {@link ensureSession} revives
   * it with a fresh pty on the same id (the "Restart shell" affordance).
   */
  exited: boolean;
  /**
   * Whether pty creation failed. A failed host is kept — not deleted — so the
   * terminal already attached to it stays wired up, and the next
   * {@link ensureSession} retries creation on the same host instead of leaving
   * the session permanently wedged with a blank pane.
   */
  failed: boolean;
  /** Whether `claude` has been launched into this pty this run (launch once). */
  launched: boolean;
  /** Resolves once the pty exists, so a launch can be queued behind creation. */
  ready: Promise<void>;
  /**
   * Whether the pty was reattached to a daemon that survived a previous app run
   * — in which case `claude` is already running in its shell and must not be
   * relaunched. Known only once {@link Host.ready} resolves.
   */
  reattached: boolean;
  /** Whether Claude was seen running since the resume, so an exit means failure. */
  resumeSawBusy: boolean;
  /** The pending resume-timeout, cleared when detection is disarmed or fires. */
  resumeTimer: ReturnType<typeof setTimeout> | undefined;
  sink: Sink | undefined;
}

const hosts = new Map<string, Host>();

/**
 * Backstop timeout for treating a resume as failed when no `SessionStart` fired.
 * The precise signal is Claude's process exiting (see {@link noteResumeBusy}),
 * which surfaces a real failure in ~1s; this timeout only covers the rare case
 * where that exit is missed. It matches the generic boot timeout (20s) so a
 * slow-but-fine resume — Claude can take several seconds just to fall back to a
 * fresh session — never false-flashes the recovery prompt before `SessionStart`.
 */
const RESUME_TIMEOUT_MS = 20_000;

/**
 * Sink for a detected failed resume (see {@link Host.awaitingResume}). Registered
 * by the app, routed to the sessions store so the UI can offer "start fresh".
 * A seam — like {@link paneBusyHandler} — so `sessionHost` needs no store import.
 */
let resumeFailedHandler: ((sessionId: string) => void) | undefined;

/** Register the handler invoked when a resume is detected as failed (idempotent). */
export function setResumeFailedHandler(
  handler: (sessionId: string) => void
): void {
  resumeFailedHandler = handler;
}

/** Disarm the resume watchdog for `host`, clearing its timer. */
function disarmResume(host: Host): void {
  host.awaitingResume = false;
  host.resumeSawBusy = false;
  if (host.resumeTimer !== undefined) {
    clearTimeout(host.resumeTimer);
    host.resumeTimer = undefined;
  }
}

/** Fire the failed-resume recovery for `sessionId` once, then disarm. */
function failResume(sessionId: string): void {
  const host = hosts.get(sessionId);
  if (!host?.awaitingResume) {
    return;
  }
  disarmResume(host);
  resumeFailedHandler?.(sessionId);
}

/**
 * Feed a foreground-busy transition into the resume watchdog: note that Claude
 * started (`busy`), or, once it has, treat its exit (`!busy`) as a failed resume.
 */
function noteResumeBusy(sessionId: string, busy: boolean): void {
  const host = hosts.get(sessionId);
  if (!host?.awaitingResume) {
    return;
  }
  if (busy) {
    host.resumeSawBusy = true;
  } else if (host.resumeSawBusy) {
    failResume(sessionId);
  }
}

/**
 * A resumed session started for real (its `SessionStart` hook fired): disarm the
 * watchdog so a later exit or the timeout can't raise a false failed-resume.
 */
export function noteSessionStarted(sessionId: string): void {
  const host = hosts.get(sessionId);
  if (host) {
    disarmResume(host);
  }
}

/**
 * Sink for per-session foreground-busy transitions from the daemon. Registered
 * by the app (see App), routed to `useTerminals.setPaneBusy`. Kept as a seam
 * here — rather than importing the store — so `sessionHost` has no dependency on
 * `state/terminals` (which already imports `disposeSession` from here; a direct
 * import back would be a cycle).
 */
let paneBusyHandler: ((sessionId: string, busy: boolean) => void) | undefined;

/** Register the handler for daemon busy transitions (idempotent). */
export function setPaneBusyHandler(
  handler: (sessionId: string, busy: boolean) => void
): void {
  paneBusyHandler = handler;
}

/**
 * Sink for session-death events (the shell exited or the daemon crashed),
 * reported once by the backend per {@link createSession}. Routed to the
 * terminals store so a dock pane can show "Shell exited" instead of wedging
 * silently. A seam — like {@link paneBusyHandler} — so `sessionHost` needs no
 * store import.
 */
let sessionExitedHandler: ((sessionId: string) => void) | undefined;

/** Register the handler invoked when a session dies underneath the app. */
export function setSessionExitedHandler(
  handler: (sessionId: string) => void
): void {
  sessionExitedHandler = handler;
}

/**
 * Ensure a pty session exists for `sessionId`, creating it exactly once. Output
 * is routed to the attached terminal's sink, or buffered until one attaches.
 * Idempotent: a second call for a live id is a no-op, so it is safe to call on
 * every (re)mount. This only opens the pty (a shell); `claude` is launched
 * separately by {@link launchClaudeOnce} the first time the session is viewed.
 *
 * `onError` is invoked if the underlying `createSession` IPC fails, after which
 * the id is released so a later mount may retry.
 *
 * Returns the session's readiness promise so callers can sequence work behind
 * pty creation — notably pushing the terminal's real size once the pty exists,
 * which would otherwise race (and lose to) the async creation.
 */
export function ensureSession(
  sessionId: string,
  cwd: string,
  onError: () => void
): Promise<void> {
  const existing = hosts.get(sessionId);
  if (existing && !existing.failed && !existing.exited) {
    return existing.ready;
  }
  // Fresh id, or a revive after a failed creation / a dead shell. A revive
  // reuses the host object so an already-attached terminal sink keeps
  // streaming from the recreated pty; only the lifecycle flags reset.
  const host: Host = existing ?? {
    exited: false,
    failed: false,
    launched: false,
    ready: Promise.resolve(),
    reattached: false,
    awaitingResume: false,
    resumeSawBusy: false,
    resumeTimer: undefined,
    sink: undefined,
  };
  host.exited = false;
  host.failed = false;
  host.launched = false;
  host.reattached = false;
  hosts.set(sessionId, host);

  host.ready = createSession(
    sessionId,
    cwd,
    (bytes) => {
      if (host.sink) {
        // Attached: the terminal's WriteQueue reports drained bytes on flush.
        host.sink(bytes);
      } else {
        // Detached (no terminal mounted): nothing else will report these
        // bytes, so the PTY reader would park at its high-water mark forever.
        // Report-and-drop — no buffering: a terminal that attaches later asks
        // the daemon for a screen repaint instead of replaying a byte-capped
        // buffer that could start mid-escape-sequence (see attachTerminal).
        ignore(reportDrained(sessionId, bytes.length));
      }
    },
    // Foreground-busy transitions flow straight to the registered handler,
    // independent of whether a terminal component is mounted — so a backgrounded
    // tab's running process is still tracked. The handler filters to real panes.
    // The same transition also feeds the resume watchdog (a no-op unless this
    // session is awaiting a resume), which detects Claude exiting on an expired
    // conversation.
    (busy) => {
      noteResumeBusy(sessionId, busy);
      paneBusyHandler?.(sessionId, busy);
    },
    // The session died underneath the app (shell exited / daemon crashed).
    // Mark the host so the next ensureSession revives it, clear any stale
    // busy flag (the poller died with the daemon, possibly mid-`true`), and
    // let the UI surface it.
    () => {
      host.exited = true;
      paneBusyHandler?.(sessionId, false);
      sessionExitedHandler?.(sessionId);
    }
  ).then((reattached) => {
    host.reattached = reattached;
    // The pty is born at a default 80x24; push the terminal's real geometry
    // now that it exists (and again after every revive — see registerSizeSync).
    sizeSyncs.get(sessionId)?.();
  });

  host.ready.catch(() => {
    // Keep the failed host so the attached terminal survives and the next
    // ensureSession (every session activation runs one) can retry creation.
    host.failed = true;
    onError();
  });

  return host.ready;
}

/**
 * Per-session geometry pushers, registered by the mounted Terminal. Invoked by
 * {@link ensureSession} whenever a pty is (re)created, because a fresh pty is
 * always 80x24 regardless of what the terminal already measures — without this,
 * a revived session renders full-screen TUIs garbled until the next resize.
 */
const sizeSyncs = new Map<string, () => void>();

/**
 * Register the terminal's size pusher for a session (see {@link sizeSyncs}).
 * Returns the unregister function — call it on terminal unmount.
 */
export function registerSizeSync(
  sessionId: string,
  sync: () => void
): () => void {
  sizeSyncs.set(sessionId, sync);
  return () => {
    if (sizeSyncs.get(sessionId) === sync) {
      sizeSyncs.delete(sessionId);
    }
  };
}

/**
 * Launch `claude` into a session's pty exactly once per run, the first time the
 * session is viewed. A session with a known [Claude session id] is *resumed*
 * (`claude --resume <id>`), restoring the conversation in both the terminal and
 * its transcript; otherwise a fresh `claude` is started.
 *
 * `KRIYON_SESSION` gates Kriyon's Claude Code hook (it only records events for
 * sessions Kriyon launched). It is set in the session shell's environment by the
 * daemon spawn (see `create_session`), so every `claude` in this shell inherits
 * it — we no longer type it as a command prefix (that was timing-fragile). We
 * never pass `--session-id` (handing Claude a *fresh* id suppresses its live
 * transcript — see ADR 0003); resuming a Claude-generated id is safe and is what
 * keeps one canonical transcript per session across launches.
 *
 * A session reattached to a surviving daemon already has `claude` running in its
 * shell, so we must NOT relaunch — re-sending the command would type it as
 * keystrokes into the live session. That's only known once the pty is ready, so
 * this resolves after creation: `true` only on the call that actually launched
 * `claude`, `false` otherwise (already launched, reattached, or no host).
 *
 * `seed`, when given and the session isn't resumable, seeds the first prompt as
 * a launch ARGUMENT — not keystroke injection into a running TUI. The prompt
 * text is written server-side to a Kriyon-owned, path-contained file (see
 * `seed_prompt`); the launch command reads that file into a shell var, deletes
 * it, then starts `claude` with it, so no user text is ever shell-escaped.
 *
 * Returns a {@link LaunchResult} rather than a bare boolean so the caller can
 * tell the failure modes apart and surface them: a dropped seed prompt
 * (`seedDropped`) and a launch write that never reached the pty (`writeFailed`)
 * used to be swallowed, leaving the user with a silently prompt-less session or
 * a boot overlay that could only time out.
 */
export type LaunchResult =
  /** `claude` was launched into the pty; track its boot (`resuming` if `--resume`). */
  | { kind: "launched"; resuming: boolean }
  /** Launched fresh, but the seed prompt file write failed — the first prompt was lost. */
  | { kind: "seedDropped" }
  /** The launch command never reached the pty; nothing started, nothing to watch. */
  | { kind: "writeFailed" }
  /** The daemon already had `claude` running; nothing to launch or track. */
  | { kind: "reattached" }
  /** No host, already launched, or a failed pty — nothing to do. */
  | { kind: "skipped" };

/** A [Nested session]'s report address, when both ids are safe to type. */
function safeReport(report: NestedReport | undefined): NestedReport | null {
  return report &&
    SAFE_CLAUDE_ID.test(report.to) &&
    SAFE_CLAUDE_ID.test(report.from)
    ? report
    : null;
}

/** The env a [Nested session]'s `claude` starts with: where its companion
 *  sends its first answer, and which conversation may send it (ADR-0049). */
function nestedLaunch(report: NestedReport | undefined): string {
  const safe = safeReport(report);
  return safe
    ? `KRIYON_REPORT_TO=${safe.to} KRIYON_REPORT_FROM=${safe.from} `
    : "";
}

/** Start a [Nested session]'s conversation under the id it reports from. */
function nestedFlags(report: NestedReport | undefined): string {
  const safe = safeReport(report);
  return safe ? ` --session-id ${safe.from}` : "";
}

export async function launchClaudeOnce(
  sessionId: string,
  claudeSessionId: string | null,
  seed?: string,
  report?: NestedReport
): Promise<LaunchResult> {
  const host = hosts.get(sessionId);
  if (!host || host.failed || host.exited || host.launched) {
    return { kind: "skipped" };
  }
  // Claim the launch synchronously so a re-entrant call is a no-op before we
  // await readiness below.
  host.launched = true;

  try {
    await host.ready;
  } catch {
    return { kind: "skipped" };
  }

  if (host.reattached) {
    return { kind: "reattached" };
  }

  const resumable = Boolean(
    claudeSessionId && SAFE_CLAUDE_ID.test(claudeSessionId)
  );
  let command: string;
  let seedDropped = false;
  if (resumable) {
    command = `claude --resume ${claudeSessionId}\r`;
  } else if (seed && seed.trim() !== "") {
    // Seed the first prompt as a launch ARGUMENT (not keystroke injection): the
    // prompt lives in a Kriyon-written, path-contained file, so no user text is
    // ever shell-escaped. Read it into a var, remove the file, launch claude.
    // `$(…)` strips the trailing newline; both the path and the value are quoted.
    const path = await seedPrompt(sessionId, seed).catch(() => null);
    if (path) {
      command = `p="$(cat "${path}")"; rm -f "${path}"; ${nestedLaunch(report)}claude${nestedFlags(report)} "$p"\r`;
    } else {
      // The seed file write failed: the user's first prompt is gone. Launch a
      // usable session anyway and let the caller surface the loss.
      command = `${nestedLaunch(report)}claude${nestedFlags(report)}\r`;
      seedDropped = true;
    }
  } else {
    command = `${nestedLaunch(report)}claude${nestedFlags(report)}\r`;
  }

  let wrote = true;
  await writeStdin(sessionId, new TextEncoder().encode(command)).catch(() => {
    wrote = false;
  });
  if (!wrote) {
    // The launch command never reached the pty: nothing started. Don't arm the
    // resume watchdog (there is no claude to exit) or a boot overlay that could
    // only hang until it times out — the caller surfaces this directly.
    return { kind: "writeFailed" };
  }

  // Only a resume can "fail" in a way worth recovering — a fresh launch that
  // errors would just fail again on retry. Arm the watchdog on that path only.
  if (resumable) {
    host.awaitingResume = true;
    host.resumeSawBusy = false;
    host.resumeTimer = setTimeout(
      () => failResume(sessionId),
      RESUME_TIMEOUT_MS
    );
  }

  return seedDropped
    ? { kind: "seedDropped" }
    : { kind: "launched", resuming: resumable };
}

/**
 * Start a fresh `claude` in a session whose resume failed (its conversation
 * expired). Disarms the watchdog and writes a plain `claude`, reusing the same
 * pty. The new session reports its own [Claude session id] via hooks, which
 * replaces the expired one. A no-op if the session's host is gone.
 */
export async function startFreshClaude(sessionId: string): Promise<void> {
  const host = hosts.get(sessionId);
  if (!host) {
    return;
  }
  disarmResume(host);
  await writeStdin(sessionId, new TextEncoder().encode("claude\r")).catch(
    () => {
      // ignored
    }
  );
}

/**
 * Attach a terminal sink to a session and stream its output live. Returns a
 * detach function that stops streaming (without tearing down the pty) — call
 * it on terminal unmount.
 *
 * The freshly-attached xterm is blank, so ask the daemon to resend its screen
 * snapshot (it arrives as ordinary output, serialized before any newer bytes).
 * On the very first mount the session usually doesn't exist yet and the
 * request errors harmlessly — the socket-level attach paints that case. This
 * is what heals a REmount (StrictMode, error boundary, future layout changes):
 * previously the new xterm stayed blank until the child next printed, and the
 * detached-byte replay it relied on could start mid-escape-sequence.
 */
export function attachTerminal(sessionId: string, sink: Sink): () => void {
  const host = hosts.get(sessionId);
  if (!host) {
    return () => {
      // No session to detach from.
    };
  }
  host.sink = sink;
  ignore(requestRepaint(sessionId));

  return () => {
    if (host.sink === sink) {
      host.sink = undefined;
    }
  };
}

/**
 * Tear down a session's pty and forget it. Called once when the session is
 * removed from the store — never on terminal unmount.
 *
 * Resolves once the daemon has actually been told to close, so a quit can wait
 * for its terminals before exiting the process. Never rejects: a missing
 * session is already gone.
 */
export function disposeSession(sessionId: string): Promise<void> {
  hosts.delete(sessionId);
  return closeSessionIpc(sessionId).catch(() => {
    // Best-effort teardown; a missing session is already gone.
  });
}
