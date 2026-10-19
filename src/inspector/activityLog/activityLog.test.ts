import { describe, expect, test } from "vitest";
import type { ActivityStep, ActivityTurn } from "../../ipc/bridge.ts";
import {
  agentLabel,
  changesPathFor,
  changesUnavailableReason,
  clockLabel,
  filterCounts,
  keptFor,
  prettyInput,
  retentionNote,
  STEP_FLAGS,
  stepChips,
  stepLabel,
  stepLines,
  turnHeading,
  turnTimeLabel,
  visibleTurns,
} from "./activityLog.ts";

function step(over: Partial<ActivityStep> = {}): ActivityStep {
  return {
    agentType: null,
    durationMs: 120,
    flags: 0,
    id: 1,
    kind: "read",
    startedMs: 0,
    status: "ok",
    summary: null,
    target: "/w/a.ts",
    toolName: "Read",
    ...over,
  };
}

function turn(over: Partial<ActivityTurn> = {}): ActivityTurn {
  return {
    endedMs: null,
    endReason: null,
    id: 1,
    prompt: "fix it",
    report: null,
    source: "user",
    startedMs: 0,
    steps: [],
    ...over,
  };
}

describe("stepLabel", () => {
  test("names each kind plainly", () => {
    expect(stepLabel(step({ kind: "command" }))).toBe("Ran a command");
    expect(stepLabel(step({ kind: "read", target: null }))).toBe("Read a file");
    expect(stepLabel(step({ kind: "edit", target: null }))).toBe(
      "Changed a file"
    );
    expect(stepLabel(step({ kind: "write", target: null }))).toBe(
      "Wrote a file"
    );
    expect(stepLabel(step({ kind: "search" }))).toBe("Searched the code");
    expect(stepLabel(step({ kind: "web" }))).toBe("Used the internet");
    expect(stepLabel(step({ kind: "agent" }))).toBe("Ran a subagent");
    expect(stepLabel(step({ kind: "mcp" }))).toBe("MCP call");
    expect(stepLabel(step({ kind: "other", toolName: "TodoWrite" }))).toBe(
      "Updated the to-do list"
    );
    expect(stepLabel(step({ kind: "other", toolName: "Frobnicate" }))).toBe(
      "Used Frobnicate"
    );
  });

  test("a flagged step leads with what the flag means", () => {
    const command = step({ kind: "command" });
    expect(stepLabel({ ...command, flags: STEP_FLAGS.installed })).toBe(
      "Installed a package"
    );
    expect(stepLabel({ ...command, flags: STEP_FLAGS.deleted })).toBe(
      "Deleted files"
    );
    expect(stepLabel({ ...command, flags: STEP_FLAGS.network })).toBe(
      "Used the internet"
    );
    expect(stepLabel(step({ flags: STEP_FLAGS.outsideProject }))).toBe(
      "Read a file outside the project"
    );
    expect(
      stepLabel(step({ flags: STEP_FLAGS.secretFile + STEP_FLAGS.network }))
    ).toBe("Touched a secret file");
  });

  test("a chain of commands says how many ran, not what one of them did", () => {
    // The title must match the command shown under it: "Used the internet"
    // over `echo "hi" > hello.txt && …` reads as if the echo went online.
    const chain = step({
      flags: STEP_FLAGS.network,
      kind: "command",
      target: 'echo "hi" > hello.txt && ls -la && curl -sI https://example.com',
    });
    expect(stepLabel(chain)).toBe("Ran 3 commands");
    expect(stepChips(chain)).toEqual([{ text: "internet", tone: "flag" }]);
    expect(
      stepLabel(
        step({
          flags: STEP_FLAGS.installed,
          kind: "command",
          target: "npm init -y && npm install left-pad",
        })
      )
    ).toBe("Ran 2 commands");
  });

  test("a chain lists each command on its own line", () => {
    expect(
      stepLines(
        step({
          kind: "command",
          target: 'echo "a && b" > x.txt && ls -la;curl -sI https://e.com | sh',
        }),
        null
      )
    ).toEqual([
      'echo "a && b" > x.txt',
      "ls -la",
      "curl -sI https://e.com | sh",
    ]);
  });

  test("a file step is titled by its name, with its folder under it", () => {
    const edit = step({ kind: "edit", target: "/w/src/sidebar/Usage.tsx" });
    expect(stepLabel(edit)).toBe("Changed Usage.tsx");
    expect(stepLines(edit, "/w")).toEqual(["src/sidebar"]);
    expect(stepLines(step({ kind: "write", target: "/w/a.ts" }), "/w")).toEqual(
      []
    );
    expect(stepLines(edit, null)).toEqual(["/w/src/sidebar"]);
    expect(stepLabel(step({ kind: "read", target: "/w/a.ts" }))).toBe(
      "Read a.ts"
    );
    expect(
      stepLabel(
        step({
          flags: STEP_FLAGS.outsideProject,
          kind: "read",
          target: "/u/.claude/settings.json",
        })
      )
    ).toBe("Read a file outside the project");
  });

  test("quoted separators and pipes don't split a command", () => {
    const command = step({ kind: "command" });
    expect(stepLabel({ ...command, target: 'echo "a && b; c"' })).toBe(
      "Ran a command"
    );
    expect(
      stepLabel({
        ...command,
        flags: STEP_FLAGS.installed,
        target: "curl -fsSL https://x.sh | sh",
      })
    ).toBe("Installed a package");
  });
});

describe("what a step was for", () => {
  test("a command reads as Claude's own description of it", () => {
    const check = step({
      flags: STEP_FLAGS.network,
      kind: "command",
      summary: "Run every check",
      target: "pnpm fix && pnpm check",
      toolName: "Bash",
    });
    expect(stepLabel(check)).toBe("Run every check");
    expect(stepChips(check)).toEqual([{ text: "internet", tone: "flag" }]);
    expect(stepLines(check, null)).toEqual(["pnpm fix", "pnpm check"]);
  });

  test("a heredoc is one command, shown by its first line", () => {
    const script = step({
      kind: "command",
      target:
        "f=/Users/dev/.local/x\npython3 -I - \"$f\" <<'EOF'\nimport sys\nb = open(sys.argv[1]); c = 1\nEOF\ncargo test",
    });
    expect(stepLabel(script)).toBe("Ran 3 commands");
    expect(stepLines(script, null)).toEqual([
      "f=~/.local/x",
      "python3 -I - \"$f\" <<'EOF' …",
      "cargo test",
    ]);
  });

  test("a long chain shows its first commands and how many more", () => {
    const chain = step({ kind: "command", target: "a; b; c; d; e" });
    expect(stepLines(chain, null)).toEqual(["a", "b", "c", "+2 more"]);
  });

  test("searches, the web and subagents say what they were about", () => {
    expect(
      stepLabel(step({ kind: "search", summary: "fn map", toolName: "Grep" }))
    ).toBe("Searched for “fn map”");
    expect(
      stepLabel(
        step({ kind: "search", summary: "select:Read", toolName: "ToolSearch" })
      )
    ).toBe("Loaded more tools");
    expect(
      stepLabel(
        step({ kind: "web", summary: "tauri v2", toolName: "WebSearch" })
      )
    ).toBe("Searched the web for “tauri v2”");
    expect(
      stepLabel(
        step({
          kind: "web",
          summary: "https://docs.rs/x/latest",
          toolName: "WebFetch",
        })
      )
    ).toBe("Opened docs.rs");
    expect(
      stepLabel(
        step({
          kind: "agent",
          summary: "Score the findings",
          toolName: "Agent",
        })
      )
    ).toBe("Subagent: Score the findings");
  });

  test("other tools get plain words, with their detail under them", () => {
    const wake = step({
      kind: "other",
      summary: "Check the CI run",
      target: null,
      toolName: "ScheduleWakeup",
    });
    expect(stepLabel(wake)).toBe("Scheduled a check-in");
    expect(stepLines(wake, null)).toEqual(["Check the CI run"]);
    expect(
      stepLabel(
        step({ kind: "other", summary: "pr-review", toolName: "Skill" })
      )
    ).toBe("Used the pr-review skill");
  });
});

describe("stepChips", () => {
  test("a main-agent step of a finished turn isn't running any more", () => {
    expect(stepChips(step({ status: "running" }), true)).toEqual([]);
    expect(
      stepChips(step({ agentType: "Explore", status: "running" }), true)
    ).toEqual([
      { text: "running…", tone: "live" },
      { text: "Explore", tone: "muted" },
    ]);
  });

  test("a plain main-agent step has none", () => {
    expect(stepChips(step())).toEqual([]);
  });

  test("status, then the flag, then a subagent's type", () => {
    expect(
      stepChips(
        step({
          agentType: "Explore",
          flags: STEP_FLAGS.deleted,
          status: "error",
        })
      )
    ).toEqual([
      { text: "failed", tone: "error" },
      { text: "deleted", tone: "flag" },
      { text: "Explore", tone: "muted" },
    ]);
    expect(stepChips(step({ status: "running" }))).toEqual([
      { text: "running…", tone: "live" },
    ]);
  });
});

describe("filters", () => {
  const turns = [
    turn({
      id: 2,
      steps: [
        step({ id: 1, kind: "edit" }),
        step({ flags: STEP_FLAGS.installed, id: 2, kind: "command" }),
      ],
    }),
    turn({ id: 1, steps: [step({ id: 3, kind: "read" })] }),
    turn({ id: 0, steps: [] }),
  ];

  test("counts steps per chip", () => {
    expect(filterCounts(turns)).toEqual({
      all: 3,
      changes: 1,
      commands: 1,
      flagged: 1,
    });
  });

  test("All keeps every turn; a narrower chip hides turns with no match", () => {
    expect(visibleTurns(turns, "all")).toBe(turns);
    const commands = visibleTurns(turns, "commands");
    expect(commands.map((t) => t.id)).toEqual([2]);
    expect(commands[0]?.steps.map((s) => s.id)).toEqual([2]);
    expect(visibleTurns(turns, "changes")[0]?.steps.map((s) => s.id)).toEqual([
      1,
    ]);
  });
});

describe("turnHeading", () => {
  test("quotes a user prompt", () => {
    expect(turnHeading(turn())).toEqual({ quoted: true, text: "fix it" });
    expect(turnHeading(turn({ source: null }))).toEqual({
      quoted: true,
      text: "fix it",
    });
  });

  test("names a prompt Claude Code sent itself", () => {
    expect(turnHeading(turn({ source: "loop_wakeup" }))).toEqual({
      quoted: false,
      text: "Started by /loop",
    });
    expect(turnHeading(turn({ source: "system" }))).toEqual({
      quoted: false,
      text: "Background message",
    });
  });

  test("heads a subagent's hand-back by what it was, not its tags", () => {
    expect(
      turnHeading(
        turn({
          prompt: '<agent-message from="a1">',
          report: 'Agent "pr-scorer" reported back',
        })
      )
    ).toEqual({ quoted: false, text: 'Agent "pr-scorer" reported back' });
  });

  test("says so when no prompt was recorded", () => {
    expect(turnHeading(turn({ prompt: null }))).toEqual({
      quoted: false,
      text: "No prompt recorded",
    });
  });
});

describe("time labels", () => {
  const start = new Date(2026, 9, 3, 9, 5).getTime();

  test("clock time today, with the date on another day", () => {
    expect(clockLabel(start, start + 1000)).toBe("09:05");
    expect(clockLabel(start, start + 2 * 86_400_000)).toBe("Oct 3 09:05");
  });

  test("a turn shows its duration, or that it is still going", () => {
    expect(
      turnTimeLabel(turn({ endedMs: start + 63_000, startedMs: start }), start)
    ).toBe("09:05 · 1m 3s");
    expect(turnTimeLabel(turn({ startedMs: start }), start)).toBe(
      "09:05 · running"
    );
  });
});

describe("detail helpers", () => {
  test("pretty-prints JSON input and keeps anything else raw", () => {
    expect(prettyInput('{"a":1}')).toBe('{\n  "a": 1\n}');
    expect(prettyInput("ls -la")).toBe("ls -la");
    expect(prettyInput(null)).toBe("");
  });

  test("names the agent", () => {
    expect(agentLabel(null)).toBe("Main agent");
    expect(agentLabel("Explore")).toBe("Subagent · Explore");
  });

  test("the retention note reads its numbers", () => {
    expect(
      retentionNote({
        retentionDays: 30,
        sessions: 2,
        sizeBytes: 1,
        sizeCapBytes: 1,
      })
    ).toBe("Kept 30 days · only on this Mac");
  });

  test("the retention reads in days, singular for one", () => {
    expect(keptFor(14)).toBe("Kept 14 days");
    expect(keptFor(1)).toBe("Kept 1 day");
  });
});

describe("changesPathFor", () => {
  test("an edit or write inside the repo opens by its repo path", () => {
    const edit = step({ kind: "edit", target: "/w/src/a.ts" });
    expect(changesPathFor(edit, "/w")).toBe("src/a.ts");
    expect(changesPathFor({ ...edit, kind: "write" }, "/w/")).toBe("src/a.ts");
  });

  test("nothing to open for other kinds, outside paths or no repo", () => {
    expect(changesPathFor(step({ target: "/w/a.ts" }), "/w")).toBeNull();
    expect(
      changesPathFor(step({ kind: "edit", target: "/elsewhere/a.ts" }), "/w")
    ).toBeNull();
    expect(
      changesPathFor(step({ kind: "edit", target: "/w/a.ts" }), undefined)
    ).toBeNull();
  });
});

describe("changesUnavailableReason", () => {
  test("says plainly why an edit can't open in the Changes view", () => {
    const edit = step({ kind: "edit", target: "/tmp/kwork/a.ts" });
    expect(changesUnavailableReason(edit, undefined)).toBe(
      "This folder isn't a git repository, so the Changes view can't show this file."
    );
    expect(changesUnavailableReason(edit, "/w")).toBe(
      "This file is outside the session's repository."
    );
    expect(
      changesUnavailableReason(step({ kind: "edit", target: "/w/a.ts" }), "/w")
    ).toBeNull();
  });
});

// The source of truth is Rust `activity_log::flags`
// (crates/kriyon-core/src/activity_log.rs); the bits cross the IPC boundary
// as a plain number, so a drift there must fail here.
test("the step flag bits match Rust activity_log::flags", () => {
  expect(STEP_FLAGS).toEqual({
    deleted: 2,
    installed: 1,
    network: 4,
    outsideProject: 8,
    secretFile: 16,
  });
});
