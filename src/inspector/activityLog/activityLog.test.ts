import { describe, expect, test } from "vitest";
import type { ActivityStep, ActivityTurn } from "../../ipc/bridge.ts";
import {
  agentLabel,
  changesPathFor,
  changesUnavailableReason,
  clockLabel,
  filterCounts,
  groupSteps,
  keptFor,
  prettyInput,
  prettyResult,
  retentionNote,
  STEP_FLAGS,
  stepChips,
  stepLabel,
  stepLines,
  stepStats,
  turnHeading,
  turnRows,
  turnTimeLabel,
  visibleTurns,
} from "./activityLog.ts";

function step(over: Partial<ActivityStep> = {}): ActivityStep {
  return {
    agentId: null,
    agentType: null,
    approved: false,
    changedFiles: [],
    created: false,
    durationMs: 120,
    flags: 0,
    id: 1,
    kind: "read",
    launchedType: null,
    linesAdded: null,
    linesRemoved: null,
    outcome: null,
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
    expect(stepChips(chain)).toEqual([{ text: "web", tone: "flag" }]);
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
    expect(stepLabel(check)).toBe("Ran every check");
    expect(stepChips(check)).toEqual([{ text: "web", tone: "flag" }]);
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

  test("subagents say their task; tool lookups stay quiet", () => {
    expect(
      stepLabel(
        step({ kind: "search", summary: "select:Read", toolName: "ToolSearch" })
      )
    ).toBe("Loaded more tools");
    expect(
      stepLines(
        step({
          kind: "search",
          summary: "select:Read",
          target: null,
          toolName: "ToolSearch",
        }),
        null
      )
    ).toEqual([]);
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
    expect(visibleTurns(turns, "all")).toEqual(turns);
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
    expect(
      prettyInput('{"command":"npm test\\n| tail","description":"Run tests"}')
    ).toBe("npm test\n| tail");
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

describe("the design's timeline", () => {
  test("a command's title is what Claude did, in the past tense", () => {
    const tests = step({
      kind: "command",
      outcome: "43 passed",
      summary: "Run the usage tests",
      target: "pnpm test usage",
      toolName: "Bash",
    });
    expect(stepLabel(tests)).toBe("Ran the usage tests");
    expect(stepStats(tests)).toEqual([{ text: "43 passed", tone: "ok" }]);
    expect(stepStats({ ...tests, outcome: "2 failed" })).toEqual([
      { text: "2 failed", tone: "error" },
    ]);
    expect(
      stepLabel({ ...tests, summary: "git status before committing" })
    ).toBe("git status before committing");
  });

  test("an install or a delete leads with what it did to the machine", () => {
    const install = step({
      approved: true,
      flags: STEP_FLAGS.installed,
      kind: "command",
      status: "ok",
      summary: "Add date-fns",
      target: "pnpm add date-fns",
      toolName: "Bash",
    });
    expect(stepLabel(install)).toBe("Installed a package");
    expect(stepLines(install, null)).toEqual(["pnpm add date-fns"]);
    expect(stepChips(install)).toEqual([
      { text: "you approved", tone: "flag" },
      { text: "installed", tone: "flag" },
    ]);
  });

  test("the web says where it went", () => {
    const fetch = step({
      flags: STEP_FLAGS.network,
      kind: "web",
      summary: "https://date-fns.org/docs/formatDistance",
      target: null,
      toolName: "WebFetch",
    });
    expect(stepLabel(fetch)).toBe("Used the internet");
    expect(stepLines(fetch, null)).toEqual([
      "date-fns.org/docs/formatDistance",
    ]);
    expect(stepChips(fetch)).toEqual([{ text: "web", tone: "flag" }]);
    const search = step({
      flags: STEP_FLAGS.network,
      kind: "web",
      summary: "tauri v2 tray",
      target: null,
      toolName: "WebSearch",
    });
    expect(stepLabel(search)).toBe("Searched the web");
    expect(stepLines(search, null)).toEqual(["“tauri v2 tray”"]);
  });

  test("a search shows what it looked for and what it found", () => {
    const grep = step({
      kind: "search",
      outcome: "6 files",
      summary: "UsageSnapshot",
      target: null,
      toolName: "Grep",
    });
    expect(stepLabel(grep)).toBe("Searched the code");
    expect(stepLines(grep, null)).toEqual(["“UsageSnapshot” · 6 files"]);
  });

  test("a file change shows its lines, and a new file reads as added", () => {
    const added = step({
      created: true,
      kind: "write",
      linesAdded: 38,
      linesRemoved: 0,
      target: "/w/src/a.test.tsx",
      toolName: "Write",
    });
    expect(stepLabel(added)).toBe("Added a.test.tsx");
    expect(stepStats(added)).toEqual([{ text: "+38", tone: "added" }]);
    const changed = step({
      kind: "edit",
      linesAdded: 12,
      linesRemoved: 3,
      target: "/w/src/a.tsx",
      toolName: "Edit",
    });
    expect(stepStats(changed)).toEqual([
      { text: "+12", tone: "added" },
      { text: "−3", tone: "removed" },
    ]);
    expect(stepOutsideLabel()).toBe("Read a file outside the project");
  });

  test("reads and changes in a row fold into one line", () => {
    const read = (id: number, target: string) =>
      step({ id, kind: "read", target });
    const rows = groupSteps([
      read(1, "/w/a.rs"),
      read(2, "/w/b.rs"),
      read(3, "/w/a.rs"),
      read(4, "/w/c.rs"),
      read(5, "/w/d.rs"),
      step({ flags: STEP_FLAGS.outsideProject, id: 6, target: "/u/x.json" }),
      step({
        id: 7,
        kind: "edit",
        linesAdded: 5,
        linesRemoved: 1,
        target: "/w/a.rs",
      }),
      step({
        id: 8,
        kind: "edit",
        linesAdded: 2,
        linesRemoved: 0,
        target: "/w/b.rs",
      }),
      step({ id: 9, kind: "command", target: "ls" }),
    ]);
    expect(rows.map((r) => r.label)).toEqual([
      "Read 4 files",
      "Read a file outside the project",
      "Changed 2 files",
      "Ran a command",
    ]);
    expect(rows[0].lines).toEqual(["a.rs, b.rs, c.rs +1"]);
    expect(rows[0].steps).toHaveLength(5);
    expect(rows[2].stats).toEqual([
      { text: "+7", tone: "added" },
      { text: "−1", tone: "removed" },
    ]);
  });

  test("a command that edited files counts as a change", () => {
    const sed = step({ kind: "command", linesAdded: 1, linesRemoved: 1 });
    expect(filterCounts([turn({ steps: [sed] })]).changes).toBe(1);
  });

  test("the same file read twice in a row stays one file", () => {
    const rows = groupSteps([
      step({ id: 1, target: "/w/a.rs" }),
      step({ id: 2, target: "/w/a.rs" }),
    ]);
    expect(rows.map((r) => r.label)).toEqual(["Read a.rs"]);
    expect(rows[0].steps).toHaveLength(2);
  });
});

function stepOutsideLabel(): string {
  return stepLabel(
    step({
      flags: STEP_FLAGS.outsideProject,
      target: "/u/.claude/settings.json",
    })
  );
}

describe("what the screenshots showed", () => {
  test("a shell loop stays one command", () => {
    const loop = step({
      kind: "command",
      target: 'for f in src/*; do echo "== $f"; cat "$f"; done; grep -n x src',
    });
    expect(stepLabel(loop)).toBe("Ran 2 commands");
    expect(stepLines(loop, null)).toEqual([
      'for f in src/*; do echo "== $f"; cat "$f"; done',
      "grep -n x src",
    ]);
  });

  test("a command names the files it changed", () => {
    const write = step({
      changedFiles: ["/w/src/format.js", "/w/src/format.test.js"],
      kind: "command",
      linesAdded: 18,
      summary: "Write format module",
      target: "cat > src/format.js <<'EOF'\nx\nEOF",
    });
    expect(stepLines(write, "/w")).toEqual([
      "cat > src/format.js <<'EOF' …",
      "Changed format.js, format.test.js",
    ]);
  });

  test("a command's result reads as its output", () => {
    expect(
      prettyResult(
        '{"stdout": "found 0\\nv24", "stderr": "", "isImage": false}'
      )
    ).toBe("found 0\nv24");
    expect(prettyResult("plain text")).toBe("plain text");
    expect(prettyResult(null)).toBe("");
  });

  test("Claude's own verbs read in the past tense", () => {
    expect(
      stepLabel(
        step({
          kind: "command",
          summary: "Init npm project",
          target: "npm init",
        })
      )
    ).toBe("Initialized npm project");
  });
});

describe("subagents", () => {
  const launch = step({
    id: 1,
    kind: "agent",
    launchedType: "Explore",
    startedMs: 100,
    summary: "Map the parser",
    target: null,
    toolName: "Agent",
  });
  const sub = (id: number, over: Partial<ActivityStep> = {}) =>
    step({
      agentId: "a1",
      agentType: "Explore",
      id,
      startedMs: 100 + id,
      target: `/w/${id}.rs`,
      ...over,
    });

  test("a subagent's steps sit under the step that started it", () => {
    const rows = turnRows(
      [
        launch,
        sub(2),
        step({ id: 3, kind: "command", startedMs: 103, target: "ls" }),
        sub(4),
        sub(5, { kind: "command", target: "cargo test" }),
      ],
      null
    );
    expect(rows.map((r) => r.label)).toEqual([
      "Subagent: Map the parser",
      "Ran a command",
    ]);
    expect(rows[0].children?.map((r) => r.label)).toEqual([
      "Read 2 files",
      "Ran a command",
    ]);
  });

  test("a subagent with no start in sight still gets its own block", () => {
    const rows = turnRows(
      [sub(2), sub(3, { kind: "command", target: "ls" })],
      null
    );
    expect(rows.map((r) => r.label)).toEqual(["Subagent · Explore"]);
    expect(rows[0].children).toHaveLength(2);
  });
});

describe("the second smoke run", () => {
  test("a subagent handing back reads as such", () => {
    expect(
      stepLabel(
        step({ kind: "other", target: null, toolName: "SubagentHandback" })
      )
    ).toBe("Reported back");
  });

  test("Claude loading its own tools isn't shown or counted", () => {
    const turns = [
      turn({
        steps: [
          step({ id: 1, kind: "search", toolName: "ToolSearch" }),
          step({ id: 2, kind: "read" }),
        ],
      }),
    ];
    expect(filterCounts(turns).all).toBe(1);
    expect(visibleTurns(turns, "all")[0].steps.map((s) => s.id)).toEqual([2]);
  });

  test("more of Claude's verbs read in the past tense", () => {
    const said = (summary: string) =>
      stepLabel(step({ kind: "command", summary, target: "x" }));
    expect(said("Append test and run suite")).toBe(
      "Appended test and ran suite"
    );
    expect(said("Review the diff")).toBe("Reviewed the diff");
  });
});

describe("the third smoke run", () => {
  const said = (summary: string) =>
    stepLabel(step({ kind: "command", summary, target: "x; y" }));

  test("every verb Claude chains reads in the past tense", () => {
    expect(said("Install dayjs and check its output")).toBe(
      "Installed dayjs and checked its output"
    );
    expect(said("Uninstall date-fns and rerun tests")).toBe(
      "Uninstalled date-fns and reran tests"
    );
    expect(said("Count lines, show model setting, print format.js")).toBe(
      "Counted lines, showed model setting, printed format.js"
    );
  });

  test("a word that may be a noun after 'and' stays as written", () => {
    expect(said("Fix the parser and test files")).toBe(
      "Fixed the parser and test files"
    );
  });

  test("removing a package says so", () => {
    expect(
      stepLabel(
        step({
          flags: STEP_FLAGS.deleted,
          kind: "command",
          summary: "Remove date-fns",
          target: "npm uninstall date-fns",
        })
      )
    ).toBe("Removed a package");
    expect(
      stepLabel(
        step({
          flags: STEP_FLAGS.deleted,
          kind: "command",
          target: "rm -rf dist",
        })
      )
    ).toBe("Deleted files");
  });
});

describe("Claude Code's own background helpers", () => {
  const helper = (over: Partial<ActivityStep>) =>
    step({ agentId: "a37", agentType: null, id: 9, ...over });

  test("a helper's check-in is housekeeping: not shown or counted", () => {
    const turns = [
      turn({
        steps: [
          helper({ kind: "other", target: null, toolName: "ScheduleWakeup" }),
        ],
      }),
    ];
    expect(filterCounts(turns).all).toBe(0);
    expect(visibleTurns(turns, "all")[0].steps).toEqual([]);
    // The main agent scheduling one is Claude acting later: it stays.
    const main = [
      turn({
        steps: [
          step({ kind: "other", target: null, toolName: "ScheduleWakeup" }),
        ],
      }),
    ];
    expect(filterCounts(main).all).toBe(1);
  });

  test("anything else a helper does shows under its own name", () => {
    const rows = turnRows([helper({ kind: "command", target: "ls" })], null);
    expect(rows.map((r) => r.label)).toEqual(["Claude Code in the background"]);
  });
});

describe("a step that did several things", () => {
  test("shows a chip for each, most serious first", () => {
    const both = step({
      flags: STEP_FLAGS.deleted + STEP_FLAGS.installed,
      kind: "command",
      summary: "Uninstall then reinstall dayjs",
      target: "npm uninstall dayjs && npm install dayjs",
    });
    expect(stepChips(both)).toEqual([
      { text: "deleted", tone: "flag" },
      { text: "installed", tone: "flag" },
    ]);
    expect(stepLabel(both)).toBe("Uninstalled then reinstalled dayjs");
  });
});
