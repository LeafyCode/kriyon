import { completedTasks } from "../state/viewedMarker.ts";
import type { SessionActivity, StudioEvent } from "../types.ts";

/** Names shown before collapsing into a total. */
const MAX_FILE_NAMES = 5;

/** First non-empty line of a text, trimmed. */
function firstLine(text: string): string | null {
  const line = text.split("\n", 1)[0]?.trim() ?? "";
  return line || null;
}

/** Analyze events and extract summary metrics. */
function analyzeEvents(events: StudioEvent[]): {
  files: string[];
  commandsRun: number;
  subagentsRan: number;
  lastAssistant: string | null;
} {
  const files: string[] = [];
  let commandsRun = 0;
  let subagentsRan = 0;
  let lastAssistant: string | null = null;
  for (const event of events) {
    if (event.kind === "diff" && !files.includes(event.file)) {
      files.push(event.file);
    } else if (event.kind === "bash") {
      commandsRun += 1;
    } else if (
      event.kind === "tool" &&
      (event.name === "Agent" || event.name === "Task")
    ) {
      subagentsRan += 1;
    } else if (event.kind === "assistant") {
      lastAssistant = firstLine(event.text) ?? lastAssistant;
    }
  }
  return { files, commandsRun, subagentsRan, lastAssistant };
}

/**
 * Compose an editable [Handoff prompt] seeding a [Follow-up session] from what
 * the predecessor did — files edited, commands run, subagents, completed tasks,
 * and its last line. Deterministic and zero-token (same digest as the
 * [Catch-up brief]); the user edits it before spawning. See CONTEXT.md.
 */
export function buildHandoffPrompt(args: {
  activity: SessionActivity | undefined;
  events: StudioEvent[];
  title: string;
}): string {
  const { files, commandsRun, subagentsRan, lastAssistant } = analyzeEvents(
    args.events
  );

  const lines: string[] = [
    `Continuing from a previous session: ${args.title}`,
    "",
  ];
  const bullets: string[] = [];
  if (files.length > 0) {
    const shown = files.slice(0, MAX_FILE_NAMES).join(", ");
    const extra =
      files.length > MAX_FILE_NAMES
        ? ` (+${files.length - MAX_FILE_NAMES} more)`
        : "";
    bullets.push(`- Edited: ${shown}${extra}`);
  }
  if (commandsRun > 0) {
    bullets.push(`- Ran ${commandsRun} command${commandsRun === 1 ? "" : "s"}`);
  }
  if (subagentsRan > 0) {
    bullets.push(
      `- Ran ${subagentsRan} subagent${subagentsRan === 1 ? "" : "s"}`
    );
  }
  const done = completedTasks(args.activity);
  if (done > 0) {
    bullets.push(`- Completed ${done} task${done === 1 ? "" : "s"}`);
  }
  if (lastAssistant) {
    bullets.push(`- Last note: ${lastAssistant}`);
  }
  if (bullets.length > 0) {
    lines.push("Recent work:", ...bullets, "");
  }
  lines.push("Pick up where it left off:", "");
  return lines.join("\n");
}
