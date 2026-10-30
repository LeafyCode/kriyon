import type { StudioEvent } from "../types.ts";

/**
 * The [Event digest]: what a run of a session's events did — the files it
 * changed, the commands it ran (and how many failed), the subagents it
 * started, and the first line of Claude's last reply. Zero-token. The
 * [Turn recap] and the [Handoff prompt] both read it, so the card and the
 * prompt its Follow up opens count the same work the same way.
 */
export interface EventDigest {
  commands: number;
  failedCommands: number;
  /** Files changed, in the order first touched. */
  files: string[];
  /** The first line of Claude's last reply, or null. */
  lastLine: string | null;
  subagents: number;
}

/** First non-empty line of a text, trimmed. */
export function firstLine(text: string): string | null {
  return text.split("\n", 1)[0]?.trim() || null;
}

export function digestEvents(events: readonly StudioEvent[]): EventDigest {
  const files: string[] = [];
  let commands = 0;
  let failedCommands = 0;
  let subagents = 0;
  let lastLine: string | null = null;
  for (const event of events) {
    if (event.kind === "diff" && !files.includes(event.file)) {
      files.push(event.file);
    } else if (event.kind === "bash") {
      commands += 1;
      failedCommands += event.exit !== null && event.exit !== 0 ? 1 : 0;
    } else if (
      event.kind === "tool" &&
      (event.name === "Agent" || event.name === "Task")
    ) {
      subagents += 1;
    } else if (event.kind === "assistant") {
      lastLine = firstLine(event.text) ?? lastLine;
    }
  }
  return { commands, failedCommands, files, lastLine, subagents };
}
