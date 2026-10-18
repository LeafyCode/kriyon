import { beforeEach, describe, expect, it, vi } from "vitest";

const dispose = vi.fn();
vi.mock("./sessionHost.ts", () => ({
  disposeSession: (id: string) => {
    dispose(id);
    return Promise.resolve();
  },
}));

const quit = vi.fn();
vi.mock("../ipc/bridge.ts", () => ({
  isTauriRuntime: () => false,
  quitApp: (intent: string) => {
    quit(intent);
    return Promise.resolve();
  },
}));

import { type UiSession, useSessions } from "../state/sessions.ts";
import { useTerminals } from "../state/terminals.ts";
import type { BackgroundShell, SessionActivity } from "../types.ts";
import {
  confirmQuit,
  handleCloseRequested,
  quitCopy,
  quitStakes,
} from "./closeOnQuit.ts";

/** A live session in the given status, minimal but shaped like the real thing. */
function session(id: string, status: UiSession["status"]): UiSession {
  return {
    archivedAt: null,
    baselineOid: null,
    claudeSessionId: null,
    createdAt: 1,
    cwd: "",
    id,
    projectId: "p",
    status,
    summary: "",
    title: id,
    titleLocked: false,
    worktreePath: null,
  };
}

beforeEach(() => {
  useTerminals.setState({
    busyPanes: {},
    byProject: {},
    deadPanes: {},
    quitConfirm: null,
  });
  useSessions.setState({ activity: {}, exited: {}, sessions: {} });
  dispose.mockClear();
  quit.mockClear();
});

describe("handleCloseRequested", () => {
  // Regression: the window's X did nothing. Tauri prevents the native close as
  // soon as a JS `onCloseRequested` listener exists, and its fallback
  // `window.destroy()` is denied by the capability ACL — so the quit has to be
  // ours, through the Rust `quit_app` command, on every path.
  it("quits at once, stopping everything, when nothing is running", async () => {
    useTerminals.getState().openTab("a", "/a");
    dispose.mockClear();
    const preventDefault = vi.fn();

    await handleCloseRequested({ preventDefault });

    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(quit).toHaveBeenCalledExactlyOnceWith("stopAll");
    expect(useTerminals.getState().quitConfirm).toBeNull();
    // Stopping is Rust's job on the way out: the frontend only knows the panes
    // it happens to have mounted, which is how sessions used to be missed.
    expect(dispose).not.toHaveBeenCalled();
  });

  // Regression: closing the window silently killed running dev servers — the
  // one close path with NO confirm, while closing a mere tab asked first.
  it("intercepts the quit and asks when a terminal process is running", async () => {
    useTerminals.getState().openTab("a", "/a");
    const paneId = useTerminals.getState().byProject.a.tabs[0].panes[0].id;
    useTerminals.getState().setPaneBusy(paneId, true);
    dispose.mockClear();
    const preventDefault = vi.fn();

    await handleCloseRequested({ preventDefault });

    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(dispose).not.toHaveBeenCalled();
    expect(quit).not.toHaveBeenCalled();
    expect(useTerminals.getState().quitConfirm).toEqual({
      busyTerminals: true,
      commands: [],
      starting: 0,
      working: 0,
    });
  });

  it("asks when a session is mid-turn, even with every terminal idle", async () => {
    useSessions.setState({ sessions: { s1: session("s1", "running") } });
    const preventDefault = vi.fn();

    await handleCloseRequested({ preventDefault });

    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(quit).not.toHaveBeenCalled();
    expect(useTerminals.getState().quitConfirm).toEqual({
      busyTerminals: false,
      commands: [],
      starting: 0,
      working: 1,
    });
  });

  // Quitting now stops every session's process tree, so a dev server Claude left
  // running in the background dies with it. That deserves a warning that names
  // it, even though the session itself is idle.
  it("asks when an idle session still has a background command running", async () => {
    const shell: BackgroundShell = {
      bashId: "b1",
      cmd: "pnpm dev",
      exit: null,
      lastPolledAt: null,
      status: "running",
    };
    useSessions.setState({
      activity: { s1: { shells: [shell] } as SessionActivity },
      sessions: { s1: session("s1", "idle") },
    });
    const preventDefault = vi.fn();

    await handleCloseRequested({ preventDefault });

    expect(quit).not.toHaveBeenCalled();
    expect(useTerminals.getState().quitConfirm).toEqual({
      busyTerminals: false,
      commands: ["pnpm dev"],
      starting: 0,
      working: 0,
    });
  });

  it("names both when a terminal is busy and a session is mid-turn", async () => {
    useTerminals.getState().openTab("a", "/a");
    const paneId = useTerminals.getState().byProject.a.tabs[0].panes[0].id;
    useTerminals.getState().setPaneBusy(paneId, true);
    useSessions.setState({ sessions: { s1: session("s1", "running") } });
    const preventDefault = vi.fn();

    await handleCloseRequested({ preventDefault });

    expect(useTerminals.getState().quitConfirm).toEqual({
      busyTerminals: true,
      commands: [],
      starting: 0,
      working: 1,
    });
  });

  // Killing claude skips the Stop hook, so the status stays "running". Without
  // the exit the app saw, every quit for the rest of the run would ask.
  it("does not ask for a session whose claude has exited", async () => {
    useSessions.setState({
      exited: { s1: true },
      sessions: { s1: session("s1", "running") },
    });
    const preventDefault = vi.fn();

    await handleCloseRequested({ preventDefault });

    expect(quit).toHaveBeenCalledExactlyOnceWith("stopAll");
    expect(useTerminals.getState().quitConfirm).toBeNull();
  });

  // A session sitting at a question is blocked on the user, not working, and
  // quitting costs it nothing — prompting there would nag on nearly every quit.
  it("does not ask for a session that is merely waiting", async () => {
    useSessions.setState({ sessions: { s1: session("s1", "waiting") } });
    const preventDefault = vi.fn();

    await handleCloseRequested({ preventDefault });

    expect(quit).toHaveBeenCalledTimes(1);
    expect(useTerminals.getState().quitConfirm).toBeNull();
  });
});

describe("confirmQuit", () => {
  it("stops everything when the user says so", async () => {
    await confirmQuit("stopAll");
    expect(quit).toHaveBeenCalledExactlyOnceWith("stopAll");
  });
});

describe("quitStakes", () => {
  it("is null when a quit would destroy nothing, so nobody is asked", () => {
    expect(
      quitStakes(false, { commands: [], starting: 0, working: 0 })
    ).toBeNull();
  });

  it("asks whenever Claude is mid-turn, even with nothing backgrounded", () => {
    expect(
      quitStakes(false, { commands: [], starting: 0, working: 1 })
    ).toEqual({
      busyTerminals: false,
      commands: [],
      starting: 0,
      working: 1,
    });
  });

  it("carries whatever is actually at stake", () => {
    expect(
      quitStakes(true, { commands: ["pnpm dev"], starting: 0, working: 2 })
    ).toEqual({
      busyTerminals: true,
      commands: ["pnpm dev"],
      starting: 0,
      working: 2,
    });
  });
});

describe("quitCopy", () => {
  it("says what is still working, and always asks the same question", () => {
    // A quit is a quit: the only choice is whether to go through with it, so
    // the title never changes with what happens to be running.
    const working = quitCopy({
      busyTerminals: false,
      commands: [],
      starting: 0,
      working: 2,
    });
    expect(working.body).toContain("2 sessions");
    expect(working.title).toBe("Quit and stop these?");

    const idle = quitCopy({
      busyTerminals: true,
      commands: ["pnpm dev"],
      starting: 0,
      working: 0,
    });
    expect(idle.title).toBe("Quit and stop these?");
  });

  it("says only what applies when a turn is the whole stake", () => {
    const copy = quitCopy({
      busyTerminals: false,
      commands: [],
      starting: 0,
      working: 1,
    });
    expect(copy.body).toContain("Claude is still working in 1 session.");
    expect(copy.body).not.toContain("running command");
    expect(copy.details).toEqual([]);
  });

  it("asks while a session is still starting up", () => {
    const stakes = quitStakes(false, { commands: [], starting: 1, working: 0 });
    expect(stakes).not.toBeNull();
    const copy = quitCopy({
      busyTerminals: false,
      commands: [],
      starting: 1,
      working: 0,
    });
    expect(copy.body).toContain("1 session still starting up");
  });

  it("never offers to leave work running", () => {
    const copy = quitCopy({
      busyTerminals: false,
      commands: [],
      starting: 0,
      working: 1,
    });
    expect(copy.body).not.toContain("Let them finish");
    expect(copy).not.toHaveProperty("canLetFinish");
  });

  it("lists the commands instead of running them into the sentence", () => {
    const copy = quitCopy({
      busyTerminals: false,
      commands: ["pnpm dev", "cargo watch"],
      starting: 0,
      working: 1,
    });
    expect(copy.body).toContain("2 running commands:");
    // The command lines are a list, not a comma-spliced tail of the sentence.
    expect(copy.body).not.toContain("pnpm dev");
    expect(copy.details).toEqual(["pnpm dev", "cargo watch"]);
  });

  it("caps a long list so the dialog stays readable", () => {
    const copy = quitCopy({
      busyTerminals: false,
      commands: ["a", "b", "c", "d", "e"],
      starting: 0,
      working: 0,
    });
    expect(copy.details).toEqual(["a", "b", "c", "and 2 more"]);
  });

  it("says one session, not 1 sessions", () => {
    const one = quitCopy({
      busyTerminals: false,
      commands: [],
      starting: 0,
      working: 1,
    });
    expect(one.body).toContain("1 session");
    expect(one.body).not.toContain("1 sessions");
  });
});
