import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
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

const QUESTION = [
  "──────────────────────────────────────────────────────────────",
  "←  ☐ Color  ☐ Pet  ✔ Submit  →",
  "",
  "What is your favourite color?",
  "",
  "❯ 1. Red",
  "  2. Blue",
  "  3. Type something.",
  "──────────────────────────────────────────────────────────────",
  "  4. Chat about this",
  "",
  "Enter to select · Tab/Arrow keys to navigate · Esc to cancel",
];

const PERMISSION = [
  " Do you want to proceed?",
  " ❯ 1. Yes",
  "   2. Yes, and always allow access to play/ from this project",
  "   4. No",
  "",
  " Esc to cancel · Tab to amend",
];

/** /resume wraps its hint onto a second row. */
const RESUME = [
  "     1 minute ago · HEAD · 2.5KB",
  "",
  "     Ctrl+A to show all projects · Ctrl+B to only show current branch",
  "     · Type to search · Esc to cancel",
];

const CONFIG = [
  "    ↓ 25 more",
  "",
  "  Enter/Space to change · / to search · Esc to close",
];

const RULE = "▔".repeat(62);

/** /usage (and /cost, /stats): a settings pane taller than the screen, its
 *  hint scrolled out of sight; only the pane's top rule shows. 2.1.296. */
const USAGE = [
  " ▝▝   ▝▝   ~/Projects/kriyon",
  RULE,
  "   Settings  Status   Config   Usage   Stats",
  "   Current session",
  "   ████▌                                              9% used",
  "   Resets 2:40pm (Europe/Lisbon)",
  "   What's contributing to your limits usage?                  ↓",
];

/** /skills puts its hint at the top of the pane, under the title. */
const SKILLS = [
  `${RULE.slice(0, 50)} ◐ medium · /effort ▔`,
  "   Skills",
  "   55 skills · enter/space to cycle, / to search, t to sort, Esc to close",
  "   ❯ ✔ anthropic-skills:deep-research          claude.ai sync · ~200 tok",
  "     ↓ 37 more",
  "   Plugin skills are managed via /plugin",
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

/** Claude's own words mention the key, but the input box is below them. */
const REPLY_MENTIONS_ESC = [
  "⏺ Press the button. Esc to cancel works too.",
  "",
  "──────────────────────────────────────────────────────────────",
  "❯ ",
  "──────────────────────────────────────────────────────────────",
  "  ? for shortcuts",
];

test("a dialog's footer hint reads as a dialog on screen", () => {
  for (const rows of [MCP, QUESTION, PERMISSION, RESUME, CONFIG]) {
    expect(dialogOnScreen(rows)).toBe(true);
  }
});

test("a pane's top rule reads as a dialog when its hint is out of sight", () => {
  expect(dialogOnScreen(USAGE)).toBe(true);
  expect(dialogOnScreen(SKILLS)).toBe(true);
});

test("a pane in a narrow terminal still reads as a dialog", () => {
  const narrow = [`${"▔".repeat(21)} ◐ medium · /effort ▔`, "   Skills"];
  expect(dialogOnScreen(narrow)).toBe(true);
});

test("a rule in Claude's own output is no dialog: it never starts the row", () => {
  // Claude's replies and tool output are drawn indented under ⏺ and ⎿.
  const reply = ["⏺ Here is the divider:", `  ${RULE}`, "", ...IDLE];
  const tool = ["  ⎿  cat banner.txt", `     ${RULE}`, "", ...IDLE];
  expect(dialogOnScreen(reply)).toBe(false);
  expect(dialogOnScreen(tool)).toBe(false);
  expect(dialogOnScreen([`▔▔▔▔▔▔▔▔ ${"words ".repeat(12)}`, ...IDLE])).toBe(
    false
  );
});

test("a short run of the rule's glyph in Claude's words is no dialog", () => {
  expect(dialogOnScreen(["⏺ The ▔▔▔ glyph is an upper block.", ...IDLE])).toBe(
    false
  );
});

test("the input box, idle or working, is no dialog", () => {
  expect(dialogOnScreen(IDLE)).toBe(false);
  expect(dialogOnScreen(WORKING)).toBe(false);
  expect(dialogOnScreen(REPLY_MENTIONS_ESC)).toBe(false);
});

test("no screen is no dialog", () => {
  expect(dialogOnScreen([])).toBe(false);
  expect(dialogOnScreen(["", "", ""])).toBe(false);
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
