import { expect, test } from "vitest";
import { spinnerTask, spinnerTip } from "./spinnerTip.ts";

const NBSP = " ";

test("the tip under the spinner is read off the screen", () => {
  const rows = [
    "❯ write a story",
    "⏺ Reading the files",
    "  ⎿  Read 3 files",
    "✳ Deliberating… (12s · esc to interrupt)",
    `  ⎿ ${NBSP}Tip: Use /memory to view and manage Claude memory`,
    "",
    "❯ ",
  ];
  expect(spinnerTip(rows)).toEqual({
    label: "Tip",
    text: "Use /memory to view and manage Claude memory",
  });
});

test("a wrapped tip is joined back into one line", () => {
  const rows = [
    "✶ Cooking… (40s · ↓ 1.2k tokens)",
    `  ⎿ ${NBSP}Tip: Use git worktrees to run multiple Claude sessions in`,
    "     parallel.",
    "❯ ",
  ];
  expect(spinnerTip(rows)?.text).toBe(
    "Use git worktrees to run multiple Claude sessions in parallel."
  );
});

test("an organisation's own label counts; a next task and a tool result don't", () => {
  expect(
    spinnerTip(["✻ Working… (3s)", `  ⎿ ${NBSP}Acme tip: Ask in #help`])
  ).toEqual({ label: "Acme tip", text: "Ask in #help" });
  expect(
    spinnerTip(["✻ Working… (3s)", `  ⎿ ${NBSP}Next: Write the tests`])
  ).toBeNull();
  // A tool result, not under a spinner.
  expect(spinnerTip(["⏺ Bash(ls)", "  ⎿  Found: 3 files"])).toBeNull();
  expect(spinnerTip(["✳ Deliberating… (1s · thinking)", "❯"])).toBeNull();
  expect(spinnerTip([])).toBeNull();
});

test("the spinner names Claude's current task, but not its filler word", () => {
  expect(
    spinnerTask([
      "⏺ Update(src/a.ts)",
      "✻ Writing the login tests… (1m 2s · ↓ 3k tokens · esc to interrupt)",
      `  ⎿ ${NBSP}Next: Run the suite`,
    ])
  ).toBe("Writing the login tests…");
  // A one-word spinner is Claude Code's filler ("Deliberating…"), not a task.
  expect(spinnerTask(["✳ Deliberating… (12s · esc to interrupt)"])).toBeNull();
  expect(spinnerTask(["❯ hi"])).toBeNull();
});

test("a reply or tool line with an ellipsis is not the spinner", () => {
  // During a dialog the spinner isn't drawn; these lines are still on screen.
  expect(
    spinnerTask(["● Bash(npm run test -- --watch=false…", "  ⎿  Running…"])
  ).toBeNull();
  expect(spinnerTask(["● Let me check the config…", "❯ "])).toBeNull();
  expect(
    spinnerTip(["● Let me check the config…", `  ⎿ ${NBSP}Tip: not a tip`])
  ).toBeNull();
  // The spinner is found below them.
  expect(
    spinnerTask([
      "● Let me check the config…",
      "✻ Checking the config files… (4s · esc to interrupt)",
    ])
  ).toBe("Checking the config files…");
});
