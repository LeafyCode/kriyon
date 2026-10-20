import { beforeEach, describe, expect, test, vi } from "vitest";

const invoke = vi.fn();
const listen = vi.fn();

vi.mock("@tauri-apps/api/core", () => {
  class MockChannel<T> {
    onmessage: ((message: T) => void) | null = null;
  }
  return {
    invoke: (...args: unknown[]) => invoke(...args),
    Channel: MockChannel,
  };
});

vi.mock("@tauri-apps/api/event", () => ({
  listen: (...args: unknown[]) => listen(...args),
}));

import { Channel } from "@tauri-apps/api/core";
import {
  activityDeleteAll,
  activityDeleteSession,
  activityStats,
  activityStep,
  activityTurns,
  closeSession,
  createSession,
  FALLBACK_RETENTION_DAYS,
  listFiles,
  listPastSessions,
  listSlashCommands,
  onActivityChanged,
  onFocusSession,
  onMenuBarMode,
  onMenuBarTheme,
  onNewSession,
  onOpenPreferences,
  onSessionActivity,
  onSessionClaudeId,
  onSessionHeartbeat,
  onSessionReady,
  onSessionResources,
  onSessionSleeping,
  onSessionStatus,
  onSessionTitle,
  onSessionUsage,
  onShowAbout,
  onTrayVisibility,
  onWorkingTreeChanged,
  openInEditor,
  openPath,
  previewNotifySound,
  resizePty,
  revealPath,
  setNotifySound,
  writeStdin,
} from "./bridge.ts";

/**
 * Every `on*` backend-event subscriber, table-driven: name (for the test
 * title), the exported subscriber itself, the exact event string it must pass
 * to `listen`, a sample payload `listen`'s handler would receive, and how to
 * assert the subscriber's own callback was invoked from that payload. Cast to
 * a uniform shape since each real export's `cb` type differs (payload
 * passthrough, a plucked field, or no argument at all) — the cast only
 * widens the parameter type for the test harness; the assertions below still
 * exercise each export's real, distinct behavior.
 */
type Unlisten = () => void;
type Subscriber = (cb: (arg: unknown) => void) => Promise<Unlisten>;

interface EventCase {
  readonly event: string;
  readonly name: string;
  readonly payload: unknown;
  readonly subscribe: Subscriber;
  readonly verify: (cb: ReturnType<typeof vi.fn>) => void;
}

const passthrough =
  (payload: unknown): ((cb: ReturnType<typeof vi.fn>) => void) =>
  (cb) =>
    expect(cb).toHaveBeenCalledWith(payload);

const called = (cb: ReturnType<typeof vi.fn>): void => {
  expect(cb).toHaveBeenCalledTimes(1);
};

const eventCases: EventCase[] = [
  {
    name: "onActivityChanged",
    subscribe: onActivityChanged as unknown as Subscriber,
    event: "activity-changed",
    payload: { sessionId: "s1" },
    verify: passthrough({ sessionId: "s1" }),
  },
  {
    name: "onSessionStatus",
    subscribe: onSessionStatus as unknown as Subscriber,
    event: "session-status",
    payload: { sessionId: "s1", status: "idle", summary: "done" },
    verify: passthrough({ sessionId: "s1", status: "idle", summary: "done" }),
  },
  {
    name: "onSessionResources",
    subscribe: onSessionResources as unknown as Subscriber,
    event: "session-resources",
    payload: { cpu: {}, sessions: { s1: 42 }, totalCpuPct: null, totalMb: 42 },
    verify: passthrough({
      cpu: {},
      sessions: { s1: 42 },
      totalCpuPct: null,
      totalMb: 42,
    }),
  },
  {
    name: "onSessionSleeping",
    subscribe: onSessionSleeping as unknown as Subscriber,
    event: "session-sleeping",
    payload: { sessionId: "s1", state: "asleep" },
    verify: passthrough({ sessionId: "s1", state: "asleep" }),
  },
  {
    name: "onSessionUsage",
    subscribe: onSessionUsage as unknown as Subscriber,
    event: "session-usage",
    payload: { sessionId: "s1", snapshot: {} },
    verify: passthrough({ sessionId: "s1", snapshot: {} }),
  },
  {
    name: "onSessionActivity",
    subscribe: onSessionActivity as unknown as Subscriber,
    event: "session-activity",
    payload: { sessionId: "s1", snapshot: {} },
    verify: passthrough({ sessionId: "s1", snapshot: {} }),
  },
  {
    name: "onSessionTitle",
    subscribe: onSessionTitle as unknown as Subscriber,
    event: "session-title",
    payload: { sessionId: "s1", title: "New title" },
    verify: passthrough({ sessionId: "s1", title: "New title" }),
  },
  {
    name: "onSessionClaudeId",
    subscribe: onSessionClaudeId as unknown as Subscriber,
    event: "session-claude-id",
    payload: { sessionId: "s1", claudeSessionId: "c1" },
    verify: passthrough({ sessionId: "s1", claudeSessionId: "c1" }),
  },
  {
    name: "onSessionReady",
    subscribe: onSessionReady as unknown as Subscriber,
    event: "session-ready",
    payload: { sessionId: "s1" },
    verify: passthrough({ sessionId: "s1" }),
  },
  {
    name: "onSessionHeartbeat",
    subscribe: onSessionHeartbeat as unknown as Subscriber,
    event: "session-heartbeat",
    payload: { sessionId: "s1", lastSeenMs: 123 },
    verify: passthrough({ sessionId: "s1", lastSeenMs: 123 }),
  },
  {
    name: "onFocusSession",
    subscribe: onFocusSession as unknown as Subscriber,
    event: "focus-session",
    payload: { sessionId: "s9" },
    verify: passthrough("s9"),
  },
  {
    name: "onShowAbout",
    subscribe: onShowAbout as unknown as Subscriber,
    event: "show-about",
    payload: undefined,
    verify: called,
  },
  {
    name: "onNewSession",
    subscribe: onNewSession as unknown as Subscriber,
    event: "new-session",
    payload: undefined,
    verify: called,
  },
  {
    name: "onOpenPreferences",
    subscribe: onOpenPreferences as unknown as Subscriber,
    event: "open-preferences",
    payload: undefined,
    verify: called,
  },
  {
    name: "onMenuBarMode",
    subscribe: onMenuBarMode as unknown as Subscriber,
    event: "menu-bar-mode",
    payload: "compact",
    verify: passthrough("compact"),
  },
  {
    name: "onMenuBarTheme",
    subscribe: onMenuBarTheme as unknown as Subscriber,
    event: "menu-bar-theme",
    payload: "dark",
    verify: passthrough("dark"),
  },
  {
    name: "onTrayVisibility",
    subscribe: onTrayVisibility as unknown as Subscriber,
    event: "tray-visibility",
    payload: true,
    verify: passthrough(true),
  },
  {
    name: "onWorkingTreeChanged",
    subscribe: onWorkingTreeChanged as unknown as Subscriber,
    event: "working-tree-changed",
    payload: { repoRoot: "/repo" },
    verify: passthrough({ repoRoot: "/repo" }),
  },
];

beforeEach(() => {
  invoke.mockReset();
  listen.mockReset();
  // The Channel-creating helpers short-circuit outside the Tauri webview;
  // mark the runtime as present so the real IPC path runs under test.
  (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ =
    {};
});

describe.each(eventCases)("$name", ({ subscribe, event, payload, verify }) => {
  test("subscribes with its exact event name and forwards the payload", async () => {
    let handler: ((e: { payload: unknown }) => void) | undefined;
    listen.mockImplementationOnce(
      (_event: string, h: (e: { payload: unknown }) => void) => {
        handler = h;
        return Promise.resolve(() => {
          // Test double unlisten.
        });
      }
    );

    const cb = vi.fn();
    await subscribe(cb);

    expect(listen).toHaveBeenCalledTimes(1);
    expect(listen.mock.calls[0]?.[0]).toBe(event);

    handler?.({ payload });
    verify(cb);
  });

  test("no-ops outside the Tauri webview", async () => {
    // biome-ignore lint/performance/noDelete: need to remove the property for testing
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;

    const cb = vi.fn();
    const unlisten = await subscribe(cb);

    expect(listen).not.toHaveBeenCalled();
    expect(cb).not.toHaveBeenCalled();
    expect(() => unlisten()).not.toThrow();
  });
});

describe("bridge", () => {
  test("createSession invokes create_session with id, cwd and channel and resolves to the reattached flag", async () => {
    invoke.mockResolvedValueOnce(true);
    const onBytes = vi.fn();

    const reattached = await createSession(
      "uuid-1",
      "/home/u",
      onBytes,
      vi.fn(),
      vi.fn()
    );

    expect(reattached).toBe(true);
    expect(invoke).toHaveBeenCalledTimes(1);
    const [command, payload] = invoke.mock.calls[0] as [
      string,
      {
        cwd: string;
        id: string;
        onBusy: unknown;
        onExit: unknown;
        onOutput: unknown;
      },
    ];
    expect(command).toBe("create_session");
    expect(payload.id).toBe("uuid-1");
    expect(payload.cwd).toBe("/home/u");
    expect(payload.onOutput).toBeInstanceOf(Channel);
    expect(payload.onBusy).toBeInstanceOf(Channel);
    expect(payload.onExit).toBeInstanceOf(Channel);
  });

  test("createSession forwards channel messages to onBytes as Uint8Array", async () => {
    invoke.mockResolvedValueOnce("uuid-1");
    const onBytes = vi.fn();

    await createSession("uuid-1", "/home/u", onBytes, vi.fn(), vi.fn());

    const [, payload] = invoke.mock.calls[0] as [
      string,
      { onOutput: { onmessage: ((message: ArrayBuffer) => void) | null } },
    ];
    const buf = new Uint8Array([104, 105]).buffer;
    payload.onOutput.onmessage?.(buf);

    expect(onBytes).toHaveBeenCalledTimes(1);
    const received = onBytes.mock.calls[0][0] as Uint8Array;
    expect(received).toBeInstanceOf(Uint8Array);
    expect(Array.from(received)).toEqual([104, 105]);
  });

  test("writeStdin sends raw stdin bytes with the session id as a header", async () => {
    invoke.mockResolvedValueOnce(undefined);

    const bytes = new Uint8Array([104, 105]);
    await writeStdin("sess-0", bytes);

    // Raw binary payload (no number-array inflation) + id carried in a header,
    // per Tauri v2's raw-request-body IPC.
    expect(invoke).toHaveBeenCalledWith("write_stdin", bytes, {
      headers: { "x-session-id": "sess-0" },
    });
  });

  test("resizePty invokes resize_pty with id, cols, rows", async () => {
    invoke.mockResolvedValueOnce(undefined);

    await resizePty("sess-0", 80, 24);

    expect(invoke).toHaveBeenCalledWith("resize_pty", {
      id: "sess-0",
      cols: 80,
      rows: 24,
    });
  });

  test("activityTurns forwards the session id and limit", async () => {
    invoke.mockResolvedValueOnce([]);
    await activityTurns("s1", 50);
    expect(invoke).toHaveBeenCalledWith("activity_turns", {
      limit: 50,
      sessionId: "s1",
    });
  });

  test("activityStep asks for one step of a session", async () => {
    invoke.mockResolvedValueOnce(null);
    expect(await activityStep("s1", 7)).toBeNull();
    expect(invoke).toHaveBeenCalledWith("activity_step", {
      sessionId: "s1",
      stepId: 7,
    });
  });

  test("activityStats and activityDeleteSession invoke their commands", async () => {
    invoke.mockResolvedValue(undefined);
    await activityStats();
    await activityDeleteSession("s1");
    expect(invoke).toHaveBeenCalledWith("activity_stats");
    expect(invoke).toHaveBeenCalledWith("activity_delete_session", {
      sessionId: "s1",
    });
  });

  test("the activity wrappers answer empty outside Tauri", async () => {
    // biome-ignore lint/performance/noDelete: need to remove the property for testing
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;

    expect(await activityTurns("s1")).toEqual([]);
    expect(await activityStep("s1", 7)).toBeNull();
    expect(await activityStats()).toEqual({
      retentionDays: FALLBACK_RETENTION_DAYS,
      sessions: 0,
      sizeBytes: 0,
      sizeCapBytes: 0,
    });
    await expect(activityDeleteSession("s1")).resolves.toBeUndefined();
    await expect(activityDeleteAll()).resolves.toBeUndefined();
    expect(invoke).not.toHaveBeenCalled();
  });

  test("closeSession invokes close_session with id", async () => {
    invoke.mockResolvedValueOnce(undefined);

    await closeSession("sess-0");

    expect(invoke).toHaveBeenCalledWith("close_session", { id: "sess-0" });
  });

  test("listPastSessions forwards cwd and limit and returns the page", async () => {
    const page = {
      items: [
        {
          claudeSessionId: "abc",
          lastActiveMs: 1_700_000_000_000,
          title: "A title",
          preview: "first prompt",
          cwd: "/work/repo",
          gitBranch: "main",
          version: "2.1.181",
          messageCount: 12,
        },
      ],
      total: 3,
    };
    invoke.mockResolvedValueOnce(page);
    const result = await listPastSessions("/work/repo", 15);
    expect(invoke).toHaveBeenCalledWith("list_past_sessions", {
      cwd: "/work/repo",
      limit: 15,
    });
    expect(result).toEqual(page);
  });

  test("listSlashCommands invokes list_slash_commands with cwd", async () => {
    invoke.mockResolvedValueOnce({
      commands: [],
      agents: [],
      claudeVersion: null,
      degraded: true,
    });

    await listSlashCommands("/repo");

    expect(invoke).toHaveBeenCalledWith("list_slash_commands", {
      cwd: "/repo",
    });
  });

  test("listFiles invokes list_files with cwd and query", async () => {
    invoke.mockResolvedValueOnce([]);

    await listFiles("/repo", "src");

    expect(invoke).toHaveBeenCalledWith("list_files", {
      cwd: "/repo",
      query: "src",
    });
  });

  test("openPath no-ops (resolves) outside Tauri", async () => {
    // Simulate browser environment by removing __TAURI_INTERNALS__
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      value: undefined,
      writable: true,
      configurable: true,
    });
    // Actually remove it so hasTauri() returns false
    Object.defineProperty(window, "__TAURI_INTERNALS__", { value: undefined });
    // biome-ignore lint/performance/noDelete: need to remove the property for testing
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;

    await expect(openPath("/proj", "docs/x.pdf")).resolves.toBeUndefined();
    expect(invoke).not.toHaveBeenCalled();
  });

  test("revealPath no-ops (resolves) outside Tauri", async () => {
    // Simulate browser environment by removing __TAURI_INTERNALS__
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      value: undefined,
      writable: true,
      configurable: true,
    });
    // Actually remove it so hasTauri() returns false
    Object.defineProperty(window, "__TAURI_INTERNALS__", { value: undefined });
    // biome-ignore lint/performance/noDelete: need to remove the property for testing
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;

    await expect(revealPath("/proj", "docs/x.pdf")).resolves.toBeUndefined();
    expect(invoke).not.toHaveBeenCalled();
  });

  test("openInEditor invokes open_in_editor with cwd and path", async () => {
    invoke.mockResolvedValueOnce(undefined);
    await openInEditor("/proj", "src/page.html");
    expect(invoke).toHaveBeenCalledWith("open_in_editor", {
      cwd: "/proj",
      path: "src/page.html",
    });
  });

  test("openInEditor no-ops (resolves) outside Tauri", async () => {
    // biome-ignore lint/performance/noDelete: need to remove the property for testing
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;

    await expect(
      openInEditor("/proj", "src/page.html")
    ).resolves.toBeUndefined();
    expect(invoke).not.toHaveBeenCalled();
  });

  test("setNotifySound invokes set_notify_sound with the sound", async () => {
    invoke.mockResolvedValueOnce(undefined);
    await setNotifySound("marimba");
    expect(invoke).toHaveBeenCalledWith("set_notify_sound", {
      sound: "marimba",
    });
  });

  test("previewNotifySound invokes preview_notify_sound with the sound", async () => {
    invoke.mockResolvedValueOnce(undefined);
    await previewNotifySound("bell");
    expect(invoke).toHaveBeenCalledWith("preview_notify_sound", {
      sound: "bell",
    });
  });
});
