import { beforeEach, expect, test, vi } from "vitest";
import {
  closeSession,
  createSession,
  reportDrained,
  requestRepaint,
  seedPrompt,
  writeStdin,
} from "../ipc/bridge.ts";
import {
  attachTerminal,
  disposeSession,
  ensureSession,
  launchClaudeOnce,
  noteSessionStarted,
  registerSizeSync,
  setResumeFailedHandler,
  setSessionExitedHandler,
  startFreshClaude,
} from "./sessionHost.ts";

vi.mock("../ipc/bridge", () => ({
  createSession: vi.fn(),
  closeSession: vi.fn(),
  writeStdin: vi.fn(),
  reportDrained: vi.fn(),
  requestRepaint: vi.fn(),
  seedPrompt: vi.fn(),
}));

const mockedCreateSession = vi.mocked(createSession);
const mockedCloseSession = vi.mocked(closeSession);
const mockedWriteStdin = vi.mocked(writeStdin);
const mockedReportDrained = vi.mocked(reportDrained);
const mockedRequestRepaint = vi.mocked(requestRepaint);
const mockedSeedPrompt = vi.mocked(seedPrompt);

/** Capture the output callback so tests can simulate backend pty output. */
let onBytes: ((bytes: Uint8Array) => void) | undefined;
/** Capture the foreground-busy callback so tests can simulate claude exiting. */
let onBusy: ((busy: boolean) => void) | undefined;
/** Capture the exit callback so tests can simulate the shell dying. */
let onExit: (() => void) | undefined;

const noop = () => {
  // error callback unused in these tests
};

/** Flush all pending microtasks (the createSession → ready → writeStdin chain). */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  vi.clearAllMocks();
  onBytes = undefined;
  onBusy = undefined;
  onExit = undefined;
  // Resolves to `reattached`: false = freshly spawned daemon (default).
  mockedCreateSession.mockImplementation((_id, _cwd, cb, busy, exit) => {
    onBytes = cb;
    onBusy = busy;
    onExit = exit;
    return Promise.resolve(false);
  });
  mockedCloseSession.mockResolvedValue(undefined);
  mockedWriteStdin.mockResolvedValue(undefined);
  mockedReportDrained.mockResolvedValue(undefined);
  mockedRequestRepaint.mockResolvedValue(undefined);
  mockedSeedPrompt.mockResolvedValue("/run/s1.prompt");
  // Reset the seams so handlers don't leak across tests.
  setResumeFailedHandler(() => {
    // no-op default
  });
  setSessionExitedHandler(() => {
    // no-op default
  });
});

test("detached output reports drained bytes; attaching hands reporting to the terminal", () => {
  ensureSession("s1", "/work", noop);

  // No terminal attached: the detached buffer path must keep the PTY reader
  // draining, or a backgrounded session would stall at the high-water mark.
  onBytes?.(new Uint8Array([1, 2, 3]));
  onBytes?.(new Uint8Array([4]));
  expect(mockedReportDrained).toHaveBeenCalledTimes(2);
  expect(mockedReportDrained).toHaveBeenNthCalledWith(1, "s1", 3);
  expect(mockedReportDrained).toHaveBeenNthCalledWith(2, "s1", 1);

  // Once a terminal attaches, the WriteQueue owns reporting; the detached path
  // must NOT also report (that would double-count drained bytes).
  attachTerminal("s1", vi.fn());
  onBytes?.(new Uint8Array([5, 6]));
  expect(mockedReportDrained).toHaveBeenCalledTimes(2);

  disposeSession("s1");
});

test("creates the pty exactly once per id, even across repeated ensure calls", () => {
  ensureSession("s1", "/work", noop);
  ensureSession("s1", "/work", noop);
  expect(mockedCreateSession).toHaveBeenCalledTimes(1);
  disposeSession("s1");
});

test("ensureSession resolves once the pty exists, so callers can size it after", async () => {
  let finishCreate: (() => void) | undefined;
  mockedCreateSession.mockImplementationOnce((_id, _cwd, cb) => {
    onBytes = cb;
    return new Promise((resolve) => {
      finishCreate = () => resolve(false);
    });
  });

  let ready = false;
  ensureSession("size-ready", "/work", noop).then(() => {
    ready = true;
  });
  await flush();
  expect(ready).toBe(false);

  finishCreate?.();
  await flush();
  expect(ready).toBe(true);
  disposeSession("size-ready");
});

test("ensureSession returns the existing readiness for an already-created id", async () => {
  ensureSession("size-existing", "/work", noop);
  await expect(
    ensureSession("size-existing", "/work", noop)
  ).resolves.toBeUndefined();
  disposeSession("size-existing");
});

test("a failed pty creation can be retried by a later ensureSession", async () => {
  mockedCreateSession.mockRejectedValueOnce(new Error("daemon spawn timeout"));
  const onError = vi.fn();

  await ensureSession("s-retry", "/work", onError).catch(noop);
  expect(onError).toHaveBeenCalledTimes(1);

  // The next ensure for the same id must try again — the old behavior left
  // the session permanently wedged with no pty and no way back.
  await ensureSession("s-retry", "/work", noop);
  expect(mockedCreateSession).toHaveBeenCalledTimes(2);
  disposeSession("s-retry");
});

test("a terminal attached before the failure keeps streaming after the retry", async () => {
  mockedCreateSession.mockRejectedValueOnce(new Error("boom"));

  await ensureSession("s-sink", "/work", noop).catch(noop);
  // The terminal mounted and attached while creation was still failing.
  const sink = vi.fn();
  attachTerminal("s-sink", sink);

  await ensureSession("s-sink", "/work", noop);
  onBytes?.(new Uint8Array([7, 8]));
  // Output from the revived pty must reach the already-attached terminal —
  // a revive that orphans the sink would render a blank pane.
  expect(sink).toHaveBeenCalledWith(new Uint8Array([7, 8]));
  disposeSession("s-sink");
});

test("a registered size sync runs after the pty is created and after a revive", async () => {
  const sync = vi.fn();
  const unregister = registerSizeSync("s-size", sync);

  await ensureSession("s-size", "/work", noop);
  // The pty is born at a default 80x24; the registered sync pushes the
  // terminal's real geometry once the pty actually exists.
  expect(sync).toHaveBeenCalledTimes(1);

  disposeSession("s-size");
  mockedCreateSession.mockRejectedValueOnce(new Error("boom"));
  await ensureSession("s-size", "/work", noop).catch(noop);
  expect(sync).toHaveBeenCalledTimes(1);

  // Revive: the recreated pty is 80x24 again — without a re-sync a
  // full-screen TUI would render garbled in the already-sized terminal.
  await ensureSession("s-size", "/work", noop);
  expect(sync).toHaveBeenCalledTimes(2);

  unregister();
  disposeSession("s-size");
});

test("launchClaudeOnce does not claim a failed host; the retried session launches", async () => {
  mockedCreateSession.mockRejectedValueOnce(new Error("boom"));

  await ensureSession("s-launch", "/work", noop).catch(noop);
  await expect(launchClaudeOnce("s-launch", null)).resolves.toEqual({
    kind: "skipped",
  });
  expect(mockedWriteStdin).not.toHaveBeenCalled();

  await ensureSession("s-launch", "/work", noop);
  await expect(launchClaudeOnce("s-launch", null)).resolves.toEqual({
    kind: "launched",
    resuming: false,
  });
  await flush();
  expect(mockedWriteStdin).toHaveBeenCalledWith(
    "s-launch",
    new TextEncoder().encode("claude\r")
  );
  disposeSession("s-launch");
});

// Detached output is NOT buffered and replayed on attach — a byte-capped
// replay could start mid-escape-sequence (garbage), and its bytes were already
// drained-reported once (replaying through the WriteQueue reported them twice,
// weakening backpressure). Instead the attach asks the daemon for a screen
// repaint, which arrives as ordinary output.
test("attach requests a daemon repaint instead of replaying detached bytes", () => {
  ensureSession("s1", "/work", noop);

  // Output before any terminal attaches is drained-reported and dropped.
  onBytes?.(new Uint8Array([1, 2]));
  onBytes?.(new Uint8Array([3]));

  const sink = vi.fn();
  attachTerminal("s1", sink);

  // No replay — the repaint request covers the screen state...
  expect(sink).not.toHaveBeenCalled();
  expect(mockedRequestRepaint).toHaveBeenCalledWith("s1");

  // ...and subsequent output streams straight through.
  onBytes?.(new Uint8Array([4]));
  expect(sink).toHaveBeenCalledTimes(1);
  expect(sink.mock.calls[0]?.[0]).toEqual(new Uint8Array([4]));

  disposeSession("s1");
});

// The end of the wedged-pane bug: the shell dying must mark the host, notify
// the registered handler (→ "Shell exited" UI), and clear any stale busy flag.
test("a session death notifies the exited handler and clears busy", async () => {
  const exited: string[] = [];
  setSessionExitedHandler((id) => exited.push(id));
  const busyEvents: [string, boolean][] = [];
  const { setPaneBusyHandler } = await import("./sessionHost.ts");
  setPaneBusyHandler((id, busy) => busyEvents.push([id, busy]));

  ensureSession("s-dead", "/work", noop);
  onBusy?.(true); // a process was running when the shell died
  onExit?.();

  expect(exited).toEqual(["s-dead"]);
  expect(busyEvents).toEqual([
    ["s-dead", true],
    ["s-dead", false],
  ]);
  disposeSession("s-dead");
});

test("ensureSession revives a dead session with a fresh pty on the same id", async () => {
  ensureSession("s-dead", "/work", noop);
  await flush();
  const sink = vi.fn();
  attachTerminal("s-dead", sink);

  onExit?.();
  // A live host is a no-op ensure; a dead one must recreate.
  await ensureSession("s-dead", "/work", noop);
  expect(mockedCreateSession).toHaveBeenCalledTimes(2);

  // The already-attached terminal keeps streaming from the revived pty.
  onBytes?.(new Uint8Array([7]));
  expect(sink).toHaveBeenCalledWith(new Uint8Array([7]));
  disposeSession("s-dead");
});

test("launchClaudeOnce skips a dead host instead of writing into a dead pty", async () => {
  ensureSession("s-dead", "/work", noop);
  await flush();
  onExit?.();

  await expect(launchClaudeOnce("s-dead", null)).resolves.toEqual({
    kind: "skipped",
  });
  expect(mockedWriteStdin).not.toHaveBeenCalled();
  disposeSession("s-dead");
});

// A dead-then-revived claude session must relaunch claude on its next
// activation: the revive resets the once-per-run launch claim.
test("a revived session can launch claude again", async () => {
  ensureSession("s-dead", "/work", noop);
  await launchClaudeOnce("s-dead", null);
  await flush();
  expect(mockedWriteStdin).toHaveBeenCalledTimes(1);

  onExit?.();
  await ensureSession("s-dead", "/work", noop);
  await expect(launchClaudeOnce("s-dead", "claude-abc")).resolves.toEqual({
    kind: "launched",
    resuming: true,
  });
  disposeSession("s-dead");
});

test("detach stops streaming without tearing down the pty", () => {
  ensureSession("s1", "/work", noop);
  const sink = vi.fn();
  const off = attachTerminal("s1", sink);
  off();

  onBytes?.(new Uint8Array([9]));
  expect(sink).not.toHaveBeenCalled();
  // The pty is untouched by detach.
  expect(mockedCloseSession).not.toHaveBeenCalled();

  disposeSession("s1");
});

test("ensureSession alone does not launch claude", async () => {
  ensureSession("s1", "/work", noop);
  await Promise.resolve();

  // Opening the pty must not start claude; that is launchClaudeOnce's job.
  expect(mockedWriteStdin).not.toHaveBeenCalled();
  disposeSession("s1");
});

test("launchClaudeOnce starts a fresh claude when there is no claude session id", async () => {
  ensureSession("s1", "/work", noop);
  launchClaudeOnce("s1", null);
  await flush();

  expect(mockedWriteStdin).toHaveBeenCalledWith(
    "s1",
    new TextEncoder().encode("claude\r")
  );
  disposeSession("s1");
});

test("launchClaudeOnce resumes when a claude session id is known", async () => {
  ensureSession("s1", "/work", noop);
  launchClaudeOnce("s1", "claude-abc");
  await flush();

  expect(mockedWriteStdin).toHaveBeenCalledWith(
    "s1",
    new TextEncoder().encode("claude --resume claude-abc\r")
  );
  disposeSession("s1");
});

test("a resumed session whose claude exits before starting reports a failed resume", async () => {
  const failed: string[] = [];
  setResumeFailedHandler((id) => failed.push(id));
  ensureSession("s1", "/work", noop);
  await launchClaudeOnce("s1", "claude-abc");

  // Claude runs, then exits (the conversation expired) with no SessionStart.
  onBusy?.(true);
  onBusy?.(false);

  expect(failed).toEqual(["s1"]);
  disposeSession("s1");
});

test("a resumed session that starts (SessionStart) does not report a failure", async () => {
  const failed: string[] = [];
  setResumeFailedHandler((id) => failed.push(id));
  ensureSession("s1", "/work", noop);
  await launchClaudeOnce("s1", "claude-abc");

  onBusy?.(true);
  noteSessionStarted("s1"); // the resume succeeded — disarm detection
  onBusy?.(false); // a later exit (user quit) must not fire the recovery

  expect(failed).toEqual([]);
  disposeSession("s1");
});

test("a resumed session that never starts reports a failed resume after the timeout", async () => {
  vi.useFakeTimers();
  try {
    const failed: string[] = [];
    setResumeFailedHandler((id) => failed.push(id));
    ensureSession("s1", "/work", noop);
    await launchClaudeOnce("s1", "claude-abc");

    expect(failed).toEqual([]);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(failed).toEqual(["s1"]);
    disposeSession("s1");
  } finally {
    vi.useRealTimers();
  }
});

test("a fresh (non-resume) launch never reports a resume failure", async () => {
  const failed: string[] = [];
  setResumeFailedHandler((id) => failed.push(id));
  ensureSession("s1", "/work", noop);
  await launchClaudeOnce("s1", null);

  onBusy?.(true);
  onBusy?.(false);

  expect(failed).toEqual([]);
  disposeSession("s1");
});

test("startFreshClaude launches a plain claude and disarms resume detection", async () => {
  const failed: string[] = [];
  setResumeFailedHandler((id) => failed.push(id));
  ensureSession("s1", "/work", noop);
  await launchClaudeOnce("s1", "claude-abc");
  mockedWriteStdin.mockClear();

  await startFreshClaude("s1");
  expect(mockedWriteStdin).toHaveBeenCalledWith(
    "s1",
    new TextEncoder().encode("claude\r")
  );

  // Detection is disarmed: a later exit of the fresh session must not fire.
  onBusy?.(true);
  onBusy?.(false);
  expect(failed).toEqual([]);
  disposeSession("s1");
});

test("launchClaudeOnce launches at most once per session", async () => {
  ensureSession("s1", "/work", noop);
  launchClaudeOnce("s1", null);
  launchClaudeOnce("s1", "claude-abc");
  await flush();

  expect(mockedWriteStdin).toHaveBeenCalledTimes(1);
  disposeSession("s1");
});

test("launchClaudeOnce ignores an unsafe claude session id and starts fresh", async () => {
  ensureSession("s1", "/work", noop);
  // A persisted value with shell metacharacters must never be interpolated.
  launchClaudeOnce("s1", "abc; rm -rf /");
  await flush();

  expect(mockedWriteStdin).toHaveBeenCalledWith(
    "s1",
    new TextEncoder().encode("claude\r")
  );
  disposeSession("s1");
});

test("launchClaudeOnce returns true on the launching call, false thereafter", async () => {
  ensureSession("ret1", "/work", noop);
  const first = launchClaudeOnce("ret1", null);
  const second = launchClaudeOnce("ret1", "claude-abc");
  await expect(first).resolves.toEqual({ kind: "launched", resuming: false });
  await expect(second).resolves.toEqual({ kind: "skipped" });
  disposeSession("ret1");
});

test("launchClaudeOnce reports skipped when there is no host", async () => {
  await expect(launchClaudeOnce("never-created", null)).resolves.toEqual({
    kind: "skipped",
  });
});

// Regression: a session reattached to a surviving daemon already has claude
// running in its shell. Re-sending the launch command would type it as
// keystrokes into the live claude's input box (and never start anything).
test("launchClaudeOnce does not relaunch a reattached session", async () => {
  mockedCreateSession.mockImplementationOnce((_id, _cwd, cb) => {
    onBytes = cb;
    return Promise.resolve(true);
  });
  ensureSession("re1", "/work", noop);

  await expect(launchClaudeOnce("re1", "claude-abc")).resolves.toEqual({
    kind: "reattached",
  });
  await flush();

  expect(mockedWriteStdin).not.toHaveBeenCalled();
  disposeSession("re1");
});

test("disposeSession closes the pty and lets a fresh ensure recreate it", () => {
  ensureSession("s1", "/work", noop);
  disposeSession("s1");
  expect(mockedCloseSession).toHaveBeenCalledWith("s1");

  ensureSession("s1", "/work", noop);
  expect(mockedCreateSession).toHaveBeenCalledTimes(2);
  disposeSession("s1");
});

test("a seeded launch reads the prompt file and self-cleans", async () => {
  ensureSession("s1", "/work", noop);
  const result = await launchClaudeOnce("s1", null, "Continue the work");

  expect(result).toEqual({ kind: "launched", resuming: false });
  expect(mockedSeedPrompt).toHaveBeenCalledWith("s1", "Continue the work");
  // Reads the file into a var, removes it, launches claude with it — quoted.
  expect(mockedWriteStdin).toHaveBeenCalledWith(
    "s1",
    new TextEncoder().encode(
      'p="$(cat "/run/s1.prompt")"; rm -f "/run/s1.prompt"; claude "$p"\r'
    )
  );
  disposeSession("s1");
});

test("a nested session starts under its own id, told where to report", async () => {
  ensureSession("s1", "/work", noop);
  await launchClaudeOnce("s1", null, "Fix it", {
    from: "child-uuid",
    to: "parent-uuid",
  });
  expect(mockedWriteStdin).toHaveBeenCalledWith(
    "s1",
    new TextEncoder().encode(
      'p="$(cat "/run/s1.prompt")"; rm -f "/run/s1.prompt"; KRIYON_REPORT_TO=parent-uuid KRIYON_REPORT_FROM=child-uuid claude --session-id child-uuid "$p"\r'
    )
  );
  disposeSession("s1");
});

test("a report address that isn't a bare id is never typed", async () => {
  ensureSession("s1", "/work", noop);
  await launchClaudeOnce("s1", null, "Fix it", {
    from: "child; rm -rf ~",
    to: "parent-uuid",
  });
  expect(mockedWriteStdin).toHaveBeenCalledWith(
    "s1",
    new TextEncoder().encode(
      'p="$(cat "/run/s1.prompt")"; rm -f "/run/s1.prompt"; claude "$p"\r'
    )
  );
  disposeSession("s1");
});

test("an unseeded launch is a plain claude", async () => {
  ensureSession("s2", "/work", noop);
  await launchClaudeOnce("s2", null);

  expect(mockedSeedPrompt).not.toHaveBeenCalled();
  expect(mockedWriteStdin).toHaveBeenCalledWith(
    "s2",
    new TextEncoder().encode("claude\r")
  );
  disposeSession("s2");
});

test("a dropped seed prompt falls back to plain claude and reports seedDropped", async () => {
  ensureSession("s1", "/work", noop);
  // The seed-prompt file write fails: the user's first prompt is lost, so the
  // caller must be told (not left thinking the session started with it).
  mockedSeedPrompt.mockRejectedValueOnce(new Error("disk full"));

  const result = await launchClaudeOnce("s1", null, "Continue the work");

  expect(result).toEqual({ kind: "seedDropped" });
  // Still launches a usable session, just without the seed.
  expect(mockedWriteStdin).toHaveBeenCalledWith(
    "s1",
    new TextEncoder().encode("claude\r")
  );
  disposeSession("s1");
});

test("a failed launch write reports writeFailed and arms no resume watchdog", async () => {
  vi.useFakeTimers();
  try {
    const failed: string[] = [];
    setResumeFailedHandler((id) => failed.push(id));
    ensureSession("s1", "/work", noop);
    // The launch keystrokes never reach the pty.
    mockedWriteStdin.mockRejectedValueOnce(new Error("pty gone"));

    const result = await launchClaudeOnce("s1", "claude-abc");

    expect(result).toEqual({ kind: "writeFailed" });
    // A resume whose command never wrote must not later false-flag a failure.
    await vi.advanceTimersByTimeAsync(20_000);
    expect(failed).toEqual([]);
    disposeSession("s1");
  } finally {
    vi.useRealTimers();
  }
});
