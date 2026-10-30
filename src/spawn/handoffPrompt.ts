import { digestEvents } from "../state/eventDigest.ts";
import { completedTasks } from "../state/viewedMarker.ts";
import type { SessionActivity, StudioEvent } from "../types.ts";

/** Names shown before collapsing into a total. */
const MAX_FILE_NAMES = 5;

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
  const {
    commands: commandsRun,
    files,
    lastLine: lastAssistant,
    subagents: subagentsRan,
  } = digestEvents(args.events);

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
