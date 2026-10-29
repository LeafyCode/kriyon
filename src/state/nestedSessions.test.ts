import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NestedRequest, SessionRequest } from "../types.ts";

vi.mock("../ipc/bridge.ts", () => ({
  bootstrapWorktree: vi.fn(() =>
    Promise.resolve({ ok: true, output: "", steps: [] })
  ),
  captureBaseline: vi.fn(() => Promise.resolve(null)),
  createWorktree: vi.fn(() => Promise.resolve()),
  isTauriRuntime: () => true,
  nestedOutcome: vi.fn(
    (initiation: string, running: number, cap: number | null) =>
      Promise.resolve(
        initiation === "user_asked" && (cap === null || running < cap)
          ? "start"
          : "propose"
      )
  ),
  takeSessionRequests: vi.fn(() => Promise.resolve([])),
  unwatchWorkingTree: vi.fn(() => Promise.resolve()),
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
  createWorktree,
  nestedOutcome,
  takeSessionRequests,
} from "../ipc/bridge.ts";
import { launchClaudeOnce } from "../terminal/sessionHost.ts";
import { showToast } from "../ui/Toast.tsx";
import { DEFAULT_LAYOUT, useLayout } from "./layout.ts";
import {
  branchForTitle,
  handleSessionRequests,
  installHeldBackStarts,
  sessionRequestsReady,
  startNestedSession,
  startProposal,
  useSessionProposals,
} from "./nestedSessions.ts";
import { idleSession, useSessions } from "./sessions.ts";

const NESTED_BRANCH = /^nested\/flaky-test-[0-9a-f]{4}$/;
const RETRY_BRANCH = /^fix-titlecase-[0-9a-f]{4}$/;

const REQUEST: SessionRequest = {
  branch: null,
  initiation: "user_asked",
  prompt: "Fix the flaky test",
  requestId: "tu1",
  title: "Flaky test",
  worktree: false,
};

function seedLead(): void {
  useSessions.setState({
    activeSessionId: null,
    pendingReport: {},
    pendingSeedPrompt: {},
    projects: [],
    sessions: {},
    warmPanes: [],
  });
  const state = useSessions.getState();
  state.addProject({
    color: null,
    id: "p1",
    name: "Repo",
    path: "/repo",
    setupCommand: null,
  });
  state.addSession(
    idleSession({
      archivedAt: null,
      baselineOid: null,
      claudeSessionId: "lead-claude",
      createdAt: 1,
      cwd: "/repo",
      id: "lead",
      projectId: "p1",
      title: "Lead",
      titleLocked: false,
      worktreePath: null,
    })
  );
}

/** The core's rule as of this writing, which the bridge mock answers with. */
function coreRule(
  initiation: string,
  running: number,
  cap: number | null
): Promise<"propose" | "start"> {
  return Promise.resolve(
    initiation === "user_asked" && (cap === null || running < cap)
      ? "start"
      : "propose"
  );
}

/** Another session, busy, so the busy count goes up by one. */
function addBusySession(id: string): void {
  useSessions.getState().addSession(
    idleSession({
      archivedAt: null,
      baselineOid: null,
      claudeSessionId: null,
      createdAt: 3,
      cwd: "/repo",
      id,
      projectId: "p1",
      title: id,
      titleLocked: false,
      worktreePath: null,
    })
  );
  useSessions.getState().applyStatus(id, "running", "", false);
}

function child() {
  return Object.values(useSessions.getState().sessions).find(
    (s) => s.nestedUnder === "lead"
  );
}

beforeEach(() => {
  seedLead();
  useLayout.setState({ layout: DEFAULT_LAYOUT });
  useSessionProposals.setState({ proposals: [], starting: [] });
  vi.mocked(createWorktree).mockReset();
  vi.mocked(nestedOutcome).mockReset().mockImplementation(coreRule);
  vi.mocked(showToast).mockClear();
});

describe("startNestedSession", () => {
  it("starts it nested under its lead session, in the background, told where to report", async () => {
    const result = await startNestedSession("lead", REQUEST, {
      focus: false,
    });
    expect(result.ok).toBe(true);
    const nested = child();
    expect(nested?.title).toBe("Flaky test");
    expect(nested?.cwd).toBe("/repo");
    const state = useSessions.getState();
    // The lead session stays on screen; the nested one is mounted out of sight.
    expect(state.activeSessionId).toBe("lead");
    expect(state.warmPanes).toContain(nested?.id);
    // Launched at once with its task, and told where to send its answer.
    await vi.waitFor(() =>
      expect(launchClaudeOnce).toHaveBeenCalledWith(
        nested?.id,
        null,
        "Fix the flaky test",
        expect.objectContaining({ to: "lead-claude" })
      )
    );
  });

  it("runs on its own worktree when asked, on the branch Claude named", async () => {
    await startNestedSession(
      "lead",
      { ...REQUEST, branch: "fix/flaky", worktree: true },
      { focus: false }
    );
    expect(createWorktree).toHaveBeenCalledWith(
      "/repo",
      "fix/flaky",
      "/repo-worktrees/fix/flaky"
    );
    expect(child()?.worktreePath).toBe("/repo-worktrees/fix/flaky");
  });

  it("names a worktree branch from the title when Claude gave none", () => {
    expect(branchForTitle("Fix the Flaky test!", "ab12")).toBe(
      "nested/fix-the-flaky-test-ab12"
    );
    expect(branchForTitle("!!!", "ab12")).toBe("nested/session-ab12");
  });

  it("names its own branch when Claude's isn't one git would take", async () => {
    await startNestedSession(
      "lead",
      { ...REQUEST, branch: "feat/.wip", worktree: true },
      { focus: false }
    );
    expect(vi.mocked(createWorktree).mock.calls[0]?.[1]).toMatch(NESTED_BRANCH);
  });

  it("takes a fresh branch when the one Claude named is taken", async () => {
    vi.mocked(createWorktree).mockRejectedValueOnce(
      new Error("fatal: a branch named 'fix-titlecase' already exists")
    );
    const result = await startNestedSession(
      "lead",
      { ...REQUEST, branch: "fix-titlecase", worktree: true },
      { focus: false }
    );
    expect(result.ok).toBe(true);
    const branches = vi.mocked(createWorktree).mock.calls.map((c) => c[1]);
    expect(branches).toHaveLength(2);
    expect(branches[0]).toBe("fix-titlecase");
    expect(branches[1]).toMatch(RETRY_BRANCH);
    expect(child()?.worktreePath).toBe(`/repo-worktrees/${branches[1]}`);
  });

  it("reports nothing when the lead session is gone", async () => {
    const result = await startNestedSession("missing", REQUEST, {
      focus: false,
    });
    expect(result.ok).toBe(false);
    expect(child()).toBeUndefined();
  });
});

describe("handleSessionRequests", () => {
  beforeEach(async () => {
    vi.mocked(takeSessionRequests).mockResolvedValueOnce([]);
    await sessionRequestsReady();
  });

  function deliver(requests: NestedRequest[]): Promise<void> {
    vi.mocked(takeSessionRequests).mockResolvedValueOnce(requests);
    return handleSessionRequests();
  }

  it("starts what the person asked for", async () => {
    await deliver([{ leadSessionId: "lead", request: REQUEST }]);
    expect(child()).toBeDefined();
    expect(useSessionProposals.getState().proposals).toEqual([]);
  });

  it("turns Claude's own idea into a suggestion on its lead session", async () => {
    await deliver([
      {
        leadSessionId: "lead",
        request: { ...REQUEST, initiation: "own_initiative" },
      },
    ]);
    expect(child()).toBeUndefined();
    expect(useSessionProposals.getState().proposals).toEqual([
      {
        leadSessionId: "lead",
        request: { ...REQUEST, initiation: "own_initiative" },
      },
    ]);
  });

  it("asks the core with the busy count and the user's cap, leaving out the session that asked", async () => {
    // The lead is always mid-turn when it asks: counting it would make the
    // same prompt start or hold back a session depending on timing alone.
    useSessions.getState().applyStatus("lead", "running", "", false);
    useSessions.getState().addSession(
      idleSession({
        archivedAt: null,
        baselineOid: null,
        claudeSessionId: null,
        createdAt: 2,
        cwd: "/repo",
        id: "other",
        projectId: "p1",
        title: "Other",
        titleLocked: false,
        worktreePath: null,
      })
    );
    useSessions.getState().applyStatus("other", "running", "", false);
    useLayout.getState().setNestedSessionCap(2);
    await deliver([{ leadSessionId: "lead", request: REQUEST }]);
    expect(nestedOutcome).toHaveBeenCalledWith("user_asked", 1, 2);
  });

  it("drops a request from a session that no longer exists", async () => {
    await deliver([{ leadSessionId: "gone", request: REQUEST }]);
    expect(nestedOutcome).not.toHaveBeenCalled();
    expect(useSessionProposals.getState().proposals).toEqual([]);
  });

  it("two asked-for requests in one batch count each other against the cap", async () => {
    vi.mocked(launchClaudeOnce).mockResolvedValue({
      kind: "launched",
      resuming: false,
    });
    useLayout.getState().setNestedSessionCap(2);
    await deliver([
      { leadSessionId: "lead", request: { ...REQUEST, requestId: "a" } },
      { leadSessionId: "lead", request: { ...REQUEST, requestId: "b" } },
      { leadSessionId: "lead", request: { ...REQUEST, requestId: "c" } },
    ]);
    // The first starts and is booting, then the second: the third is over.
    expect(vi.mocked(nestedOutcome).mock.calls.map((c) => c[1])).toEqual([
      0, 1, 2,
    ]);
    expect(
      useSessionProposals.getState().proposals.map((p) => p.request.requestId)
    ).toEqual(["c"]);
    vi.mocked(launchClaudeOnce).mockResolvedValue({ kind: "skipped" });
  });

  it("a nested session whose launch fails is not left booting", async () => {
    vi.mocked(launchClaudeOnce).mockResolvedValueOnce({ kind: "writeFailed" });
    await startNestedSession("lead", REQUEST, { focus: false });
    const id = child()?.id ?? "";
    await vi.waitFor(() => expect(launchClaudeOnce).toHaveBeenCalled());
    await Promise.resolve();
    expect(useSessions.getState().bootPhase[id] ?? "idle").not.toBe("booting");
  });

  it("one request that fails doesn't stop the ones after it", async () => {
    vi.mocked(nestedOutcome).mockRejectedValueOnce(new Error("ipc down"));
    await deliver([
      { leadSessionId: "lead", request: { ...REQUEST, requestId: "a" } },
    ]);
    await deliver([{ leadSessionId: "lead", request: REQUEST }]);
    expect(child()).toBeDefined();
  });

  it("a session you asked for that hit the limit starts on its own once one finishes", async () => {
    const stop = installHeldBackStarts();
    useSessions.getState().addSession(
      idleSession({
        archivedAt: null,
        baselineOid: null,
        claudeSessionId: null,
        createdAt: 2,
        cwd: "/repo",
        id: "other",
        projectId: "p1",
        title: "Other",
        titleLocked: false,
        worktreePath: null,
      })
    );
    useSessions.getState().applyStatus("other", "running", "", false);
    useLayout.getState().setNestedSessionCap(1);
    await deliver([
      { leadSessionId: "lead", request: REQUEST },
      {
        leadSessionId: "lead",
        request: {
          ...REQUEST,
          initiation: "own_initiative",
          requestId: "idea",
        },
      },
    ]);
    expect(child()).toBeUndefined();

    useSessions.getState().applyStatus("other", "done", "", false);
    await vi.waitFor(() => expect(child()).toBeDefined());
    // Claude's own idea still waits for the person.
    expect(
      useSessionProposals.getState().proposals.map((p) => p.request.requestId)
    ).toEqual(["idea"]);
    stop();
  });

  let stopWatching: () => void = () => undefined;
  afterEach(() => {
    stopWatching();
    stopWatching = () => undefined;
  });

  /** One busy session and a cap of 1, so `REQUEST` is held back; returns
   *  the hold-back watcher's unsubscribe. */
  async function holdBack(): Promise<() => void> {
    stopWatching = installHeldBackStarts();
    const stop = stopWatching;
    useSessions.getState().addSession(
      idleSession({
        archivedAt: null,
        baselineOid: null,
        claudeSessionId: null,
        createdAt: 2,
        cwd: "/repo",
        id: "other",
        projectId: "p1",
        title: "Other",
        titleLocked: false,
        worktreePath: null,
      })
    );
    useSessions.getState().applyStatus("other", "running", "", false);
    useLayout.getState().setNestedSessionCap(1);
    // Its own id: the module remembers what it last asked the core about.
    const request = { ...REQUEST, requestId: crypto.randomUUID() };
    await deliver([{ leadSessionId: "lead", request }]);
    expect(useSessionProposals.getState().proposals).toHaveLength(1);
    return stop;
  }

  it("a held-back session whose lead was archived does not start", async () => {
    const stop = await holdBack();
    useSessions.getState().archiveSession("lead");
    useSessions.getState().applyStatus("other", "done", "", false);
    await handleSessionRequests();
    expect(child()).toBeUndefined();
    stop();
  });

  it("a held-back request leaves with its lead when the lead is closed", async () => {
    const stop = await holdBack();
    useSessions.getState().removeSession("lead");
    useSessions.getState().applyStatus("other", "done", "", false);
    await handleSessionRequests();
    expect(useSessionProposals.getState().proposals).toEqual([]);
    expect(showToast).not.toHaveBeenCalled();
    stop();
  });

  it("a slot freeing while the card starts the request doesn't start it twice", async () => {
    const stop = await holdBack();
    let finish: () => void = () => undefined;
    vi.mocked(createWorktree).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        })
    );
    const [proposal] = useSessionProposals.getState().proposals;
    if (!proposal) {
      throw new Error("expected a held-back request");
    }
    const fromCard = startProposal(proposal, true);
    useSessions.getState().applyStatus("other", "done", "", false);
    await handleSessionRequests();
    finish();
    await fromCard;
    await handleSessionRequests();
    expect(createWorktree).toHaveBeenCalledTimes(1);
    expect(
      Object.values(useSessions.getState().sessions).filter(
        (s) => s.nestedUnder === "lead"
      )
    ).toHaveLength(1);
    stop();
  });

  it("a slot that frees while the core is being asked still starts the held-back session", async () => {
    const stop = await holdBack();
    // Something else changes first, so the core is asked while still full.
    let answer: (outcome: "propose") => void = () => undefined;
    vi.mocked(nestedOutcome).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          answer = resolve;
        })
    );
    addBusySession("third");
    await vi.waitFor(() => expect(nestedOutcome).toHaveBeenCalledTimes(2));
    // While it answers (from the old count), both busy sessions finish.
    useSessions.getState().applyStatus("other", "done", "", false);
    useSessions.getState().applyStatus("third", "done", "", false);
    answer("propose");
    await vi.waitFor(() => expect(child()).toBeDefined());
    stop();
  });

  it("the core, not this module, decides when a held-back session fits", async () => {
    const stop = await holdBack();
    // A core rule that lets user-asked sessions through at any count.
    vi.mocked(nestedOutcome).mockResolvedValue("start");
    addBusySession("third");
    await vi.waitFor(() => expect(child()).toBeDefined());
    stop();
  });

  it("a dismissed suggestion leaves the list", () => {
    useSessionProposals.getState().add({
      leadSessionId: "lead",
      request: REQUEST,
    });
    useSessionProposals.getState().dismiss("tu1");
    expect(useSessionProposals.getState().proposals).toEqual([]);
  });
});
