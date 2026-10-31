import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PastSession, ProjectRow } from "../types.ts";

vi.mock("../ipc/bridge.ts", () => ({
  bootstrapWorktree: vi.fn(() =>
    Promise.resolve({ ok: true, output: "", steps: [] })
  ),
  captureBaseline: vi.fn(() => Promise.resolve("default-baseline-oid")),
  createWorktree: vi.fn(() => Promise.resolve()),
  isTauriRuntime: () => true,
  pickDirectory: vi.fn(),
  sleepIdleSessions: vi.fn(() => Promise.resolve(0)),
  upsertProject: vi.fn(() => Promise.resolve()),
  upsertSession: vi.fn(() => Promise.resolve()),
  worktreePathFor: vi.fn((_r: string, b: string) =>
    Promise.resolve(`/repo-worktrees/${b}`)
  ),
}));

vi.mock("../terminal/sessionHost.ts", () => ({
  disposeSession: vi.fn(() => Promise.resolve()),
  ensureSession: vi.fn(() => Promise.resolve()),
  launchClaudeOnce: vi.fn(() => Promise.resolve({ kind: "skipped" })),
  noteSessionStarted: vi.fn(),
  startFreshClaude: vi.fn(() => Promise.resolve()),
}));

vi.mock("../ui/Toast.tsx", () => ({ showToast: vi.fn() }));

import {
  captureBaseline,
  sleepIdleSessions,
  upsertProject,
  upsertSession,
} from "../ipc/bridge.ts";
import {
  disposeSession,
  ensureSession,
  type LaunchResult,
  launchClaudeOnce,
} from "../terminal/sessionHost.ts";
import { showToast } from "../ui/Toast.tsx";
import {
  archiveSessionAndStop,
  BOOT_TIMEOUT_MS,
  beginBoot,
  createSessionInDefaultProject,
  createSessionInFolder,
  createSessionInProject,
  focusSessionFromNotification,
  launchActiveSession,
  noteResumeFailed,
  parkProjectAndStop,
  prewarmSession,
  projectParkCost,
  restartSessionFresh,
  resumePastSession,
  sessionBecameLive,
  setDefaultCwd,
  sleepIdleSessionsNow,
  spawnFollowUpSession,
} from "./actions.ts";
import { useBootTimes } from "./bootTiming.ts";
import { DEFAULT_LAYOUT, useLayout } from "./layout.ts";
import {
  idleSession,
  sessionRow,
  type UiSession,
  useSessions,
} from "./sessions.ts";
import { useTerminals } from "./terminals.ts";

/** Flush pending microtasks — the `captureBaseline().then(setBaseline)` chain
 * fired-and-forgotten by `createSession` after it returns synchronously. */
function flushPromises(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function pastSession(overrides: Partial<PastSession> = {}): PastSession {
  return {
    claudeSessionId: "claude-123",
    lastActiveMs: 1_700_000_000_000,
    title: "Refactor the parser",
    preview: "please refactor",
    cwd: "/work/repo",
    gitBranch: "main",
    version: "2.1.181",
    messageCount: 8,
    ...overrides,
  };
}

describe("resumePastSession", () => {
  beforeEach(() => {
    useSessions.setState({
      activeSessionId: null,
      projects: [],
      sessions: {},
    });
  });

  it("creates a session carrying the Claude id and activates it", () => {
    resumePastSession(pastSession());
    const state = useSessions.getState();

    expect(state.projects).toEqual([
      {
        color: null,
        id: "/work/repo",
        name: "repo",
        path: "/work/repo",
        parkedAt: null,
        setupCommand: null,
      },
    ]);
    const created = Object.values(state.sessions);
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      claudeSessionId: "claude-123",
      cwd: "/work/repo",
      projectId: "/work/repo",
      title: "Refactor the parser",
      status: "idle",
    });
    expect(state.activeSessionId).toBe(created[0].id);
  });

  it("falls back to the first prompt when there is no ai-title", () => {
    resumePastSession(pastSession({ title: null }));
    const [created] = Object.values(useSessions.getState().sessions);
    expect(created.title).toBe("please refactor");
  });

  it("falls back to the cwd basename when there is no title or preview", () => {
    resumePastSession(pastSession({ preview: null, title: null }));
    const [created] = Object.values(useSessions.getState().sessions);
    expect(created.title).toBe("repo");
  });
});

describe("idleSession", () => {
  it("builds an idle UiSession from a session row", () => {
    const session = idleSession({
      archivedAt: null,
      baselineOid: null,
      claudeSessionId: null,
      createdAt: 7,
      cwd: "/x",
      id: "s1",
      projectId: "p1",
      title: "Demo",
      titleLocked: false,
      worktreePath: null,
    });
    expect(session).toEqual({
      archivedAt: null,
      baselineOid: null,
      claudeSessionId: null,
      createdAt: 7,
      cwd: "/x",
      id: "s1",
      projectId: "p1",
      status: "idle",
      summary: "",
      title: "Demo",
      titleLocked: false,
      worktreePath: null,
    });
  });
});

describe("createSessionInFolder", () => {
  beforeEach(() => {
    useSessions.setState({ projects: [], sessions: {}, activeSessionId: null });
    setDefaultCwd("");
  });

  it("creates a project and makes the new session active", () => {
    createSessionInFolder("/work/proj");
    const state = useSessions.getState();
    expect(state.projects).toHaveLength(1);
    expect(state.projects[0]).toMatchObject({
      id: "/work/proj",
      name: "proj",
      path: "/work/proj",
    });
    const ids = Object.keys(state.sessions);
    expect(ids).toHaveLength(1);
    const [id] = ids;
    expect(state.activeSessionId).toBe(id);
    expect(state.sessions[id]).toMatchObject({
      claudeSessionId: null,
      cwd: "/work/proj",
      projectId: "/work/proj",
      status: "idle",
      title: "proj",
    });
  });

  it("reuses one project for two sessions in the same folder", () => {
    createSessionInFolder("/work/proj");
    createSessionInFolder("/work/proj");
    const state = useSessions.getState();
    expect(state.projects).toHaveLength(1);
    expect(Object.keys(state.sessions)).toHaveLength(2);
  });
});

describe("createSession baseline capture", () => {
  const project: ProjectRow = {
    color: null,
    id: "/repo",
    name: "repo",
    path: "/repo",
    parkedAt: null,
    setupCommand: null,
  };

  beforeEach(() => {
    useSessions.setState({ projects: [], sessions: {}, activeSessionId: null });
    vi.mocked(captureBaseline).mockReset();
    setDefaultCwd("");
  });

  it("captures and stores a baseline oid on session creation", async () => {
    vi.mocked(captureBaseline).mockResolvedValue("cafebabe");
    createSessionInProject(project);
    const [id] = Object.keys(useSessions.getState().sessions);
    await flushPromises();
    expect(captureBaseline).toHaveBeenCalledWith("/repo");
    expect(useSessions.getState().sessions[id].baselineOid).toBe("cafebabe");
    expect(upsertSession).toHaveBeenLastCalledWith(
      expect.objectContaining({ baselineOid: "cafebabe" })
    );
  });

  it("falls back to null baseline when capture fails", async () => {
    vi.mocked(captureBaseline).mockRejectedValue(new Error("not a repo"));
    createSessionInProject(project);
    const [id] = Object.keys(useSessions.getState().sessions);
    await flushPromises();
    expect(useSessions.getState().sessions[id].baselineOid).toBeNull();
  });

  it("never captures a baseline for a Home (default-cwd) session — git add -A over $HOME is unsafe", async () => {
    // MEDIUM: `capture_baseline` runs `git add -A` over the whole tree. If
    // `~` is itself a git repo (a dotfiles checkout), that walks and
    // content-hashes every non-ignored file under the user's HOME directory
    // on every Home session. A Home session must never trigger it.
    setDefaultCwd("/Users/test-home");
    createSessionInDefaultProject();
    await flushPromises();
    expect(captureBaseline).not.toHaveBeenCalled();
  });

  it("still captures a baseline for a normal project session even when a default cwd is set", async () => {
    setDefaultCwd("/Users/test-home");
    vi.mocked(captureBaseline).mockResolvedValue("cafebabe");
    createSessionInProject(project);
    await flushPromises();
    expect(captureBaseline).toHaveBeenCalledWith("/repo");
  });
});

describe("focusSessionFromNotification", () => {
  beforeEach(() => {
    useLayout.setState({ layout: DEFAULT_LAYOUT });
    useSessions.setState({ activeSessionId: null, projects: [], sessions: {} });
  });

  it("focuses a known session and routes to its raw view", () => {
    useSessions.getState().addSession(
      idleSession({
        archivedAt: null,
        baselineOid: null,
        claudeSessionId: null,
        createdAt: 0,
        cwd: "/tmp",
        id: "s1",
        projectId: "p1",
        title: "Fix login",
        titleLocked: false,
        worktreePath: null,
      })
    );
    useSessions.getState().addSession(
      idleSession({
        archivedAt: null,
        baselineOid: null,
        claudeSessionId: null,
        createdAt: 0,
        cwd: "/tmp",
        id: "s2",
        projectId: "p1",
        title: "Fix signup",
        titleLocked: false,
        worktreePath: null,
      })
    );
    useSessions.getState().setActiveSession("s2");
    expect(useSessions.getState().activeSessionId).toBe("s2");

    focusSessionFromNotification("s1");

    expect(useSessions.getState().activeSessionId).toBe("s1");
    expect(useLayout.getState().layout.view).toBe("studio");
    expect(useLayout.getState().layout.transcriptView).toBe("raw");
  });

  it("stays in Focus, which already shows the session", () => {
    useSessions.getState().addSession(
      idleSession({
        archivedAt: null,
        baselineOid: null,
        claudeSessionId: null,
        createdAt: 0,
        cwd: "/tmp",
        id: "s1",
        projectId: "p1",
        title: "Fix login",
        titleLocked: false,
        worktreePath: null,
      })
    );
    useLayout.getState().setView("focus");

    focusSessionFromNotification("s1");

    expect(useSessions.getState().activeSessionId).toBe("s1");
    expect(useLayout.getState().layout.view).toBe("focus");
    expect(useLayout.getState().layout.transcriptView).toBe("raw");
  });

  it("ignores an unknown session id (untrusted IPC input)", () => {
    focusSessionFromNotification("ghost");
    expect(useSessions.getState().activeSessionId).toBeNull();
  });
});

describe("spawnFollowUpSession", () => {
  const project: ProjectRow = {
    color: null,
    id: "p1",
    name: "Repo",
    path: "/repo",
    parkedAt: null,
    setupCommand: null,
  };
  const predecessor: UiSession = {
    archivedAt: null,
    baselineOid: null,
    claudeSessionId: null,
    createdAt: 1,
    cwd: "/repo",
    id: "pre",
    projectId: "p1",
    status: "done",
    summary: "",
    title: "Predecessor",
    titleLocked: false,
    worktreePath: null,
  };

  beforeEach(() => {
    useSessions.setState({
      activeSessionId: null,
      pendingSeedPrompt: {},
      projects: [],
      sessions: {},
    });
  });

  it("a worktree follow-up creates the worktree, seeds the prompt, and activates", async () => {
    const result = await spawnFollowUpSession({
      predecessor,
      project,
      promptText: "Continue",
      worktree: { branch: "feat/x" },
    });
    expect(result.ok).toBe(true);
    const state = useSessions.getState();
    const created = Object.values(state.sessions).find((s) => s.id !== "pre");
    expect(created?.worktreePath).toBe("/repo-worktrees/feat/x");
    expect(created?.cwd).toBe("/repo-worktrees/feat/x");
    expect(state.activeSessionId).toBe(created?.id);
    // Seed stashed for the launch effect to consume.
    expect(state.pendingSeedPrompt[created?.id ?? ""]).toBe("Continue");
  });

  it("a same-checkout follow-up reuses the predecessor cwd, no worktree", async () => {
    const result = await spawnFollowUpSession({
      predecessor,
      project,
      promptText: "Continue",
      worktree: null,
    });
    expect(result.ok).toBe(true);
    const created = Object.values(useSessions.getState().sessions).find(
      (s) => s.id !== "pre"
    );
    expect(created?.worktreePath).toBeNull();
    expect(created?.cwd).toBe("/repo");
  });

  it("a follow-up records its predecessor as the handoff link", async () => {
    await spawnFollowUpSession({
      predecessor,
      project,
      promptText: "Continue",
      worktree: { branch: "feat/x" },
    });
    await spawnFollowUpSession({
      predecessor,
      project,
      promptText: "Continue",
      worktree: null,
    });
    const created = Object.values(useSessions.getState().sessions).filter(
      (s) => s.id !== "pre"
    );
    expect(created.map((s) => s.parentSessionId)).toEqual(["pre", "pre"]);
    expect(created.map((s) => sessionRow(s).parentSessionId)).toEqual([
      "pre",
      "pre",
    ]);
  });

  it("a project-anchored spawn has no handoff link", async () => {
    await spawnFollowUpSession({ project, promptText: "", worktree: null });
    const [created] = Object.values(useSessions.getState().sessions);
    expect(created?.parentSessionId ?? null).toBeNull();
  });

  it("a project-anchored worktree spawn (no predecessor) runs in the worktree", async () => {
    const result = await spawnFollowUpSession({
      project,
      promptText: "",
      worktree: { branch: "feat/y" },
    });
    expect(result.ok).toBe(true);
    const state = useSessions.getState();
    const [created] = Object.values(state.sessions);
    expect(created?.worktreePath).toBe("/repo-worktrees/feat/y");
    expect(created?.cwd).toBe("/repo-worktrees/feat/y");
    expect(created?.title).toBe("feat/y");
    // An empty prompt seeds nothing — the session just opens in the worktree.
    expect(state.pendingSeedPrompt[created?.id ?? ""]).toBeUndefined();
  });

  it("a project-anchored spawn without a worktree runs at the project root", async () => {
    const result = await spawnFollowUpSession({
      project,
      promptText: "Start here",
      worktree: null,
    });
    expect(result.ok).toBe(true);
    const state = useSessions.getState();
    const [created] = Object.values(state.sessions);
    expect(created?.cwd).toBe("/repo");
    expect(created?.worktreePath).toBeNull();
    expect(created?.title).toBe("Repo");
    expect(state.pendingSeedPrompt[created?.id ?? ""]).toBe("Start here");
  });
});

describe("resume lifecycle transitions", () => {
  function seedSession(id: string, overrides: Partial<UiSession> = {}): void {
    useSessions.getState().addSession(
      idleSession({
        archivedAt: null,
        baselineOid: null,
        claudeSessionId: null,
        createdAt: 1,
        cwd: "/tmp",
        id,
        projectId: "p1",
        title: id,
        titleLocked: false,
        worktreePath: null,
        ...overrides,
      })
    );
  }

  const phaseOf = (id: string) =>
    useSessions.getState().bootPhase[id] ?? "idle";

  beforeEach(() => {
    useSessions.setState({
      activeSessionId: null,
      projects: [],
      bootPhase: {},
      hooksOff: {},
      sessions: {},
    });
  });

  it("a session with Kriyon's hooks off never reports a failed resume", () => {
    // With the hooks off, a resume that worked can't fire SessionStart, so the
    // watchdog's exit/timeout signals can't tell success from failure.
    seedSession("s1", { claudeSessionId: "claude-abc" });
    useSessions.getState().applyHooksOff("s1", "user");
    beginBoot("s1");
    noteResumeFailed("s1");
    expect(phaseOf("s1")).toBe("booting");
  });

  it("sessionBecameLive clears the recovery prompt and the loading overlay", () => {
    seedSession("s1");
    beginBoot("s1");
    noteResumeFailed("s1");
    // A real SessionStart recovered it: the phase goes straight to live.
    sessionBecameLive("s1");
    expect(phaseOf("s1")).toBe("live");
  });

  it("restartSessionFresh clears the prompt and re-shows the loading overlay", () => {
    seedSession("s1");
    beginBoot("s1");
    noteResumeFailed("s1"); // recovery prompt is up
    restartSessionFresh("s1");
    // Relaunch moves resumeFailed straight back to booting.
    expect(phaseOf("s1")).toBe("booting");
  });

  it("restartSessionFresh arms a boot-timeout that clears a stuck overlay", () => {
    vi.useFakeTimers();
    seedSession("s1");
    restartSessionFresh("s1");
    expect(phaseOf("s1")).toBe("booting");
    // If the fresh claude never fires SessionStart, the overlay must not hang.
    vi.advanceTimersByTime(BOOT_TIMEOUT_MS);
    expect(phaseOf("s1")).toBe("live");
    vi.useRealTimers();
  });

  it("a stale boot-timeout from a prior cycle never clears a later boot's overlay", () => {
    // The /review regression: cycle 1 arms a 20s timer; the resume fails and the
    // user restarts fresh (cycle 2) inside that window. Cycle 1's timer must be
    // cancelled, or it fires mid-cycle-2 and dismisses the overlay early.
    vi.useFakeTimers();
    seedSession("s1", { claudeSessionId: "claude-abc" });

    beginBoot("s1"); // cycle 1: timer armed at t=0 (fires t=20s)
    expect(phaseOf("s1")).toBe("booting");

    vi.advanceTimersByTime(8000); // t=8s: watchdog detects the failed resume
    noteResumeFailed("s1");
    expect(phaseOf("s1")).toBe("resumeFailed");

    vi.advanceTimersByTime(2000); // t=10s: user restarts fresh (cycle 2)
    restartSessionFresh("s1");
    expect(phaseOf("s1")).toBe("booting");

    vi.advanceTimersByTime(10_000); // t=20s: cycle-1 timer would have fired here
    expect(phaseOf("s1")).toBe("booting"); // cancelled — overlay still up

    vi.advanceTimersByTime(10_000); // t=30s: cycle-2's own timer fires
    expect(phaseOf("s1")).toBe("live");
    vi.useRealTimers();
  });

  it("launchActiveSession shows the overlay even if the user switched away mid-launch", async () => {
    seedSession("s1");
    seedSession("s2");
    useSessions.getState().setActiveSession("s1");

    // The pty takes a while to come up; the user switches away meanwhile.
    let resolveLaunch: (result: LaunchResult) => void = () => undefined;
    vi.mocked(launchClaudeOnce).mockReturnValue(
      new Promise((resolve) => {
        resolveLaunch = resolve;
      })
    );
    const pending = launchActiveSession("s1");
    useSessions.getState().setActiveSession("s2");
    resolveLaunch({ kind: "launched", resuming: false });
    await pending;

    // The launch really happened, so the boot overlay must be armed — the
    // user returning to s1 would otherwise stare at a blank pane.
    expect(phaseOf("s1")).toBe("booting");
  });

  it("launchActiveSession arms a boot-timeout that clears a stuck overlay", async () => {
    vi.useFakeTimers();
    seedSession("s1");
    vi.mocked(launchClaudeOnce).mockResolvedValue({
      kind: "launched",
      resuming: false,
    });
    await launchActiveSession("s1");
    expect(phaseOf("s1")).toBe("booting");
    vi.advanceTimersByTime(BOOT_TIMEOUT_MS);
    expect(phaseOf("s1")).not.toBe("booting");
    vi.useRealTimers();
  });

  it("launchActiveSession leaves a reattached session alone (no overlay)", async () => {
    seedSession("s1");
    vi.mocked(launchClaudeOnce).mockResolvedValue({ kind: "reattached" });
    await launchActiveSession("s1");
    expect(phaseOf("s1")).not.toBe("booting");
  });

  it("launchActiveSession still shows the overlay but warns when the seed prompt was dropped", async () => {
    seedSession("s1");
    vi.mocked(launchClaudeOnce).mockResolvedValue({ kind: "seedDropped" });
    await launchActiveSession("s1");
    // The session started, so the boot overlay is armed…
    expect(phaseOf("s1")).toBe("booting");
    // …but the user is told their first prompt was lost.
    expect(showToast).toHaveBeenCalledWith(
      "Could not send the first prompt — enter it in the terminal",
      "error"
    );
  });

  it("launchActiveSession surfaces a failed launch write without a hanging overlay", async () => {
    seedSession("s1");
    vi.mocked(launchClaudeOnce).mockResolvedValue({ kind: "writeFailed" });
    await launchActiveSession("s1");
    // Nothing launched: no overlay to hang, and a direct error toast.
    expect(phaseOf("s1")).not.toBe("booting");
    expect(showToast).toHaveBeenCalledWith(
      "Could not start the session",
      "error"
    );
  });

  it("launchActiveSession ensures the pty exists first — the retry after a failed creation", async () => {
    seedSession("s1");
    vi.mocked(launchClaudeOnce).mockResolvedValue({
      kind: "launched",
      resuming: false,
    });
    await launchActiveSession("s1");
    expect(ensureSession).toHaveBeenCalledWith(
      "s1",
      "/tmp",
      expect.any(Function)
    );
  });

  it("launchActiveSession does not launch (or arm the overlay) when pty creation fails", async () => {
    seedSession("s1");
    vi.mocked(launchClaudeOnce).mockClear();
    vi.mocked(ensureSession).mockRejectedValueOnce(new Error("spawn timeout"));
    await launchActiveSession("s1");
    expect(launchClaudeOnce).not.toHaveBeenCalled();
    expect(phaseOf("s1")).not.toBe("booting");
  });

  it("a launch shows as launching until it settles, and a failed one returns to rest", async () => {
    seedSession("s1");
    let finish: (result: LaunchResult) => void = () => undefined;
    vi.mocked(launchClaudeOnce).mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      })
    );
    const pending = launchActiveSession("s1");
    expect(phaseOf("s1")).toBe("launching");
    finish({ kind: "writeFailed" });
    await pending;
    expect(phaseOf("s1")).toBe("idle");
  });

  it("a second launch of the same session joins the first instead of clearing it", async () => {
    seedSession("s1");
    vi.mocked(launchClaudeOnce).mockClear();
    let finish: (result: LaunchResult) => void = () => undefined;
    vi.mocked(launchClaudeOnce).mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      })
    );
    // Opened in the background, then the user clicks the row mid-launch.
    const first = launchActiveSession("s1");
    const second = launchActiveSession("s1");
    await Promise.resolve();
    expect(phaseOf("s1")).toBe("launching");
    finish({ kind: "launched", resuming: false });
    await Promise.all([first, second]);
    expect(launchClaudeOnce).toHaveBeenCalledTimes(1);
    expect(phaseOf("s1")).toBe("booting");
  });

  it("a session can launch again once its last attempt settled", async () => {
    seedSession("s1");
    vi.mocked(launchClaudeOnce).mockClear();
    vi.mocked(launchClaudeOnce).mockResolvedValueOnce({ kind: "writeFailed" });
    await launchActiveSession("s1");
    vi.mocked(launchClaudeOnce).mockResolvedValueOnce({
      kind: "launched",
      resuming: false,
    });
    await launchActiveSession("s1");
    expect(launchClaudeOnce).toHaveBeenCalledTimes(2);
    expect(phaseOf("s1")).toBe("booting");
  });

  it("a launch whose pty fails to open returns to rest", async () => {
    seedSession("s1");
    vi.mocked(ensureSession).mockRejectedValueOnce(new Error("spawn timeout"));
    await launchActiveSession("s1");
    expect(phaseOf("s1")).toBe("idle");
  });

  it("a launch that throws still returns to rest", async () => {
    seedSession("s1");
    vi.mocked(launchClaudeOnce).mockRejectedValueOnce(new Error("boom"));
    await expect(launchActiveSession("s1")).rejects.toThrow("boom");
    expect(phaseOf("s1")).toBe("idle");
  });

  it("activating a session claude already runs in leaves it as it was", async () => {
    seedSession("s1");
    vi.mocked(launchClaudeOnce).mockResolvedValueOnce({ kind: "reattached" });
    await launchActiveSession("s1");
    expect(phaseOf("s1")).toBe("idle");
    useSessions.getState().applyBootEvent("s1", "started");
    vi.mocked(launchClaudeOnce).mockResolvedValueOnce({ kind: "reattached" });
    await launchActiveSession("s1");
    expect(phaseOf("s1")).toBe("live");
  });

  it("times a boot from launch to live", () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    seedSession("s1");
    beginBoot("s1");
    vi.setSystemTime(11_300);
    sessionBecameLive("s1");
    expect(useBootTimes.getState().ms.s1).toBe(1300);
    vi.useRealTimers();
  });

  it("a live signal with no boot underway records no time", () => {
    seedSession("s1");
    useBootTimes.setState({ ms: {}, started: {} });
    sessionBecameLive("s1");
    expect(useBootTimes.getState().ms.s1).toBeUndefined();
  });

  it("prewarmSession opens the pty early without launching claude", async () => {
    // The first session added becomes the active one; s2 is not mounted.
    seedSession("s1");
    seedSession("s2");
    vi.mocked(ensureSession).mockClear();
    vi.mocked(launchClaudeOnce).mockClear();
    await prewarmSession("s2");
    expect(ensureSession).toHaveBeenCalledWith(
      "s2",
      "/tmp",
      expect.any(Function)
    );
    expect(launchClaudeOnce).not.toHaveBeenCalled();
  });

  it("prewarmSession leaves a pane that is already mounted alone", async () => {
    seedSession("s1");
    useSessions.getState().setActiveSession("s1");
    vi.mocked(ensureSession).mockClear();
    await prewarmSession("s1");
    expect(ensureSession).not.toHaveBeenCalled();
  });

  it("prewarmSession swallows a pty that fails to open", async () => {
    seedSession("s1");
    seedSession("s2");
    vi.mocked(ensureSession).mockRejectedValueOnce(new Error("spawn timeout"));
    await expect(prewarmSession("s2")).resolves.toBeUndefined();
    expect(showToast).not.toHaveBeenCalledWith(
      "Could not start the session",
      "error"
    );
  });
});

/** A persisted row for `id`, shaped like the store's. */
function row(id: string) {
  return {
    archivedAt: null,
    baselineOid: null,
    claudeSessionId: null,
    createdAt: 1,
    cwd: "/x",
    id,
    projectId: "p1",
    title: id,
    titleLocked: false,
    worktreePath: null,
  };
}

describe("archiveSessionAndStop", () => {
  beforeEach(() => {
    vi.mocked(disposeSession).mockClear();
  });

  // Archiving used to set a flag and nothing else, so an archived session's
  // claude kept running — out of sight, holding memory — until the machine
  // rebooted. Out of sight has to mean stopped.
  it("stops the session's processes as well as flagging it", () => {
    useSessions.setState({
      activeSessionId: "s1",
      sessions: { s1: idleSession(row("s1")) },
      warmPanes: [],
    });

    archiveSessionAndStop("s1");

    expect(disposeSession).toHaveBeenCalledExactlyOnceWith("s1");
    expect(useSessions.getState().sessions.s1?.archivedAt).toBeGreaterThan(0);
  });

  it("says what archiving gave back, and stays quiet when it was nothing", () => {
    vi.mocked(showToast).mockClear();
    useSessions.setState({
      activeSessionId: null,
      memory: { big: 712, tiny: 12 },
      sessions: {
        big: idleSession(row("big")),
        tiny: idleSession(row("tiny")),
      },
      warmPanes: [],
    });

    archiveSessionAndStop("tiny");
    expect(showToast).not.toHaveBeenCalled();

    archiveSessionAndStop("big");
    expect(showToast).toHaveBeenCalledExactlyOnceWith(
      "Archived — freed about 712 MB"
    );
  });

  it("leaves the row in place: archive is not close", () => {
    useSessions.setState({
      activeSessionId: null,
      sessions: { s1: idleSession(row("s1")) },
      warmPanes: [],
    });

    archiveSessionAndStop("s1");

    expect(useSessions.getState().sessions.s1).toBeDefined();
  });
});

describe("sleepIdleSessionsNow", () => {
  beforeEach(() => {
    vi.mocked(showToast).mockClear();
  });

  it("says how many sessions are going to sleep", async () => {
    vi.mocked(sleepIdleSessions).mockResolvedValueOnce(3);
    await sleepIdleSessionsNow();
    expect(showToast).toHaveBeenCalledExactlyOnceWith(
      "3 sessions going to sleep — each wakes when you open it"
    );
  });

  it("uses the singular for one", async () => {
    vi.mocked(sleepIdleSessions).mockResolvedValueOnce(1);
    await sleepIdleSessionsNow();
    expect(showToast).toHaveBeenCalledExactlyOnceWith(
      "1 session going to sleep — it wakes when you open it"
    );
  });

  // Silence would read as "it did nothing because it is broken".
  it("explains itself when there was nothing to sleep", async () => {
    vi.mocked(sleepIdleSessions).mockResolvedValueOnce(0);
    await sleepIdleSessionsNow();
    expect(showToast).toHaveBeenCalledExactlyOnceWith(
      "Nothing to sleep — every session is busy, on screen, or already asleep"
    );
  });

  it("reports a failure instead of swallowing it", async () => {
    vi.mocked(sleepIdleSessions).mockRejectedValueOnce(new Error("boom"));
    await sleepIdleSessionsNow();
    expect(showToast).toHaveBeenCalledExactlyOnceWith(
      "Could not sleep idle sessions: boom",
      "error"
    );
  });
});

describe("parking a project", () => {
  function project(id: string, parkedAt: number | null = null): ProjectRow {
    return {
      color: null,
      id,
      name: id,
      parkedAt,
      path: `/${id}`,
      setupCommand: null,
    };
  }
  function inProject(id: string, projectId: string): UiSession {
    return idleSession({ ...row(id), projectId });
  }
  function terminalsFor(projectId: string, paneIds: string[]) {
    return {
      [projectId]: {
        activeTabId: "t1",
        tabs: [
          {
            activePaneId: paneIds[0] ?? "",
            direction: "row" as const,
            id: "t1",
            layout: [],
            panes: paneIds.map((id) => ({ cwd: "/x", id })),
            title: "dev",
          },
        ],
      },
    };
  }

  beforeEach(() => {
    vi.mocked(disposeSession).mockClear();
    vi.mocked(upsertProject).mockClear();
    vi.mocked(showToast).mockClear();
    useTerminals.setState({
      busyPanes: {},
      byProject: {},
      deadPanes: {},
    });
  });

  it("stops every session and terminal in the project and nothing else", () => {
    useSessions.setState({
      activeSessionId: "b1",
      projects: [project("pa"), project("pb")],
      sessions: {
        a1: inProject("a1", "pa"),
        a2: inProject("a2", "pa"),
        old: { ...inProject("old", "pa"), archivedAt: 5 },
        b1: inProject("b1", "pb"),
      },
      warmPanes: [],
    });
    useTerminals.setState({
      byProject: {
        ...terminalsFor("pa", ["pane-a"]),
        ...terminalsFor("pb", ["pane-b"]),
      },
    });

    parkProjectAndStop("pa");

    const stopped = vi.mocked(disposeSession).mock.calls.map(([id]) => id);
    // The archived one is already stopped.
    expect(stopped).toEqual(expect.arrayContaining(["a1", "a2", "pane-a"]));
    expect(stopped).toHaveLength(3);
    expect(
      useSessions.getState().projects.find((p) => p.id === "pa")?.parkedAt
    ).toBeGreaterThan(0);
    // The terminal layout stays, so unparking brings the tabs back.
    expect(useTerminals.getState().byProject.pa?.tabs[0]?.panes).toHaveLength(
      1
    );
    expect(showToast).toHaveBeenCalledExactlyOnceWith(
      "Parked pa · 2 sessions and 1 terminal stopped"
    );
  });

  it("saves the parked flag at once rather than waiting for the debounce", () => {
    useSessions.setState({
      activeSessionId: null,
      projects: [project("pa")],
      sessions: { a1: inProject("a1", "pa") },
      warmPanes: [],
    });

    parkProjectAndStop("pa");

    const saved = vi.mocked(upsertProject).mock.lastCall?.[0];
    expect(saved?.id).toBe("pa");
    expect(saved?.parkedAt).toBeGreaterThan(0);
  });

  it("clears the stopped terminals' busy flags so a quit does not count them", () => {
    useSessions.setState({
      activeSessionId: null,
      projects: [project("pa")],
      sessions: {},
      warmPanes: [],
    });
    useTerminals.setState({
      busyPanes: { "pane-a": true },
      byProject: terminalsFor("pa", ["pane-a"]),
    });

    parkProjectAndStop("pa");

    expect(useTerminals.getState().hasBusyPanes()).toBe(false);
  });

  it("names what parking would stop", () => {
    useSessions.setState({
      activity: {},
      bootPhase: {},
      exited: {},
      projects: [project("pa")],
      sessions: {
        a1: { ...inProject("a1", "pa"), status: "running" },
        a2: inProject("a2", "pa"),
      },
    });
    useTerminals.setState({
      busyPanes: { "pane-a": true },
      byProject: terminalsFor("pa", ["pane-a", "pane-b"]),
    });

    expect(projectParkCost("pa")).toEqual({
      busyTerminals: 1,
      commands: [],
      sessionIds: ["a1", "a2"],
      starting: 0,
      working: 1,
    });
  });

  it("starting a new session in a parked project unparks it", () => {
    useSessions.setState({
      activeSessionId: null,
      projects: [
        { ...project("/work/proj", 10), name: "proj", path: "/work/proj" },
      ],
      sessions: {},
    });

    createSessionInFolder("/work/proj");

    expect(useSessions.getState().projects[0]?.parkedAt).toBeNull();
    expect(vi.mocked(upsertProject).mock.lastCall?.[0].parkedAt).toBeNull();
  });

  it("resuming a past session in a parked project unparks it", () => {
    useSessions.setState({
      activeSessionId: null,
      projects: [
        { ...project("/work/proj", 10), name: "proj", path: "/work/proj" },
      ],
      sessions: {},
    });

    resumePastSession(pastSession({ cwd: "/work/proj" }));

    expect(useSessions.getState().projects[0]?.parkedAt).toBeNull();
  });
});
