import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import sharedScreens from "../../crates/kriyon-core/scripts/dialog-screens.json" with {
  type: "json",
};
import { useSessions } from "../state/sessions.ts";
import { registerScreenText } from "../terminal/screenText.ts";
import type { PendingAsk } from "../types.ts";
import {
  cliDialogOpen,
  dialogOnScreen,
  followCliDialog,
  watchCliDialog,
} from "./cliDialog.ts";

// The bottom rows of real Claude Code 2.1.294 screens.

const MCP = [
  "❯ /mcp",
  "",
  "──────────────────────────────────────────────────────────────",
  "  Manage MCP servers",
  "  7 servers",
  "",
  "  ❯ ✔ claude.ai Claude Docs    8 tools",
  "",
  "  https://code.claude.com/docs/en/mcp for help",
  " ↑/↓ to navigate · Enter to confirm · Esc to cancel",
  "",
  "",
];

const PERMISSION = [
  " Do you want to proceed?",
  " ❯ 1. Yes",
  "   2. Yes, and always allow access to play/ from this project",
  "   4. No",
  "",
  " Esc to cancel · Tab to amend",
];

const IDLE = [
  "──────────────────────────────────────────────────────────────",
  '❯ Try "refactor <filepath>"',
  "──────────────────────────────────────────────────────────────",
  "  Opus 5.5",
  "  ⏵⏵ auto mode on (shift+tab to cycle)",
];

const WORKING = [
  "✻ Brewing… (3s · esc to interrupt)",
  "",
  "──────────────────────────────────────────────────────────────",
  "❯ ",
  "──────────────────────────────────────────────────────────────",
  "  ? for shortcuts",
];

/** Screens shared with Rust's `kriyon_core::cli_dialog`, so the two rules
 *  can't drift apart. */
const SHARED: { dialog: boolean; name: string; rows: string[] }[] =
  sharedScreens;

test.each(SHARED)("$name", ({ dialog, rows }) => {
  expect(dialogOnScreen(rows)).toBe(dialog);
});

function askFor(sessionId: string, pendingAsk: PendingAsk | null): void {
  useSessions.setState((state) => ({
    activity: {
      ...state.activity,
      [sessionId]: {
        main: { currentTool: null },
        pendingAsk,
        shells: [],
        subagents: [],
        tasks: [],
      },
    },
  }));
}

describe("watching a session for a dialog", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useSessions.setState({ activity: {} });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test("one read of the screen per beat, however many watch it", () => {
    const read = vi.fn(() => MCP);
    const unregister = registerScreenText("s1", read);
    const stops = [watchCliDialog("s1"), watchCliDialog("s1")];
    read.mockClear();
    vi.advanceTimersByTime(1000);
    const perWatch = read.mock.calls.length;
    for (const stop of stops) {
      stop();
    }
    const single = watchCliDialog("s1");
    read.mockClear();
    vi.advanceTimersByTime(1000);
    expect(perWatch).toBe(read.mock.calls.length);
    single();
    unregister();
  });

  test("a dialog on screen is open while watched, and forgotten after", () => {
    const unregister = registerScreenText("s1", () => MCP);
    expect(cliDialogOpen("s1")).toBe(false);
    const stop = watchCliDialog("s1");
    expect(cliDialogOpen("s1")).toBe(true);
    stop();
    // Never shown stale when watching starts again.
    expect(cliDialogOpen("s1")).toBe(false);
    unregister();
  });

  test("a question or a plan to approve is a dialog with nothing on screen", () => {
    askFor("s1", { askedAt: null, kind: "question", text: "Which db?" });
    expect(cliDialogOpen("s1")).toBe(true);
    askFor("s1", { askedAt: null, kind: "plan_approval", text: "Plan" });
    expect(cliDialogOpen("s1")).toBe(true);
  });

  test("a permission once answered is no dialog while its tool still runs", () => {
    // The ask stays open until the approved tool finishes; only the screen
    // tells whether the prompt itself is still up.
    let rows = PERMISSION;
    const unregister = registerScreenText("s1", () => rows);
    askFor("s1", { askedAt: null, kind: "permission", text: "Run tests?" });
    const stop = watchCliDialog("s1");
    expect(cliDialogOpen("s1")).toBe(true);
    rows = WORKING;
    vi.advanceTimersByTime(1000);
    expect(cliDialogOpen("s1")).toBe(false);
    stop();
    unregister();
  });

  test("a follower hears each open and close", () => {
    let rows = IDLE;
    const unregister = registerScreenText("s1", () => rows);
    const heard: boolean[] = [];
    const stop = followCliDialog("s1", (open) => heard.push(open));
    rows = MCP;
    vi.advanceTimersByTime(1000);
    rows = IDLE;
    vi.advanceTimersByTime(1000);
    askFor("s1", { askedAt: null, kind: "question", text: "Which db?" });
    askFor("s1", null);
    expect(heard).toEqual([true, false, true, false]);
    stop();
    unregister();
  });
});
