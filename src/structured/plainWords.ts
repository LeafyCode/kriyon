import type { StepKind, StructuredTurn, TurnItem } from "../ipc/bridge.ts";

/**
 * Plain words for the [Structured view]: what a step was, how long Claude
 * thought, and the folded "What Claude did" line.
 */

const VERBS: Record<StepKind, string> = {
  agent: "Subagent",
  command: "Ran",
  edit: "Changed",
  mcp: "MCP",
  other: "Used",
  read: "Read",
  search: "Searched",
  web: "Web",
  write: "Wrote",
};

/** The short verb a step reads as — by the kind Rust gave it, so the
 *  Structured view and the Activity tab name a tool the same way. */
export function stepVerb(kind: StepKind): string {
  return VERBS[kind];
}

/** "Thought for 12s" — the API hides the thinking itself. */
export function thoughtLabel(durationMs: number | null): string {
  if (durationMs === null) {
    return "Thought";
  }
  return `Thought for ${Math.max(1, Math.round(durationMs / 1000))}s`;
}

/** How a count of each kind of step reads: [verb, one, many]. */
const PHRASES: Record<StepKind, [string, string, string]> = {
  agent: ["ran", "subagent", "subagents"],
  command: ["ran", "command", "commands"],
  edit: ["changed", "file", "files"],
  mcp: ["made", "MCP call", "MCP calls"],
  other: ["used", "tool", "tools"],
  read: ["read", "file", "files"],
  search: ["ran", "search", "searches"],
  web: ["made", "web request", "web requests"],
  write: ["wrote", "file", "files"],
};

/** "read 2 files · ran 1 command · changed 1 file": the steps of a turn, by
 *  kind, in first-seen order. */
export function didSummary(did: TurnItem[]): string {
  const counts = new Map<StepKind, number>();
  for (const item of did) {
    if (item.kind === "step") {
      counts.set(item.stepKind, (counts.get(item.stepKind) ?? 0) + 1);
    }
  }
  if (counts.size === 0) {
    return "nothing but the reply";
  }
  return [...counts]
    .map(([kind, n]) => {
      const [verb, one, many] = PHRASES[kind];
      return `${verb} ${n} ${n === 1 ? one : many}`;
    })
    .join(" · ");
}

/** "12s", "3m 4s", "1h 2m": how long a turn ran, from its first row to its
 *  newest; `null` when a time is unknown or it took under a second. */
export function durationLabel(
  startedMs: number | null,
  endedMs: number | null
): string | null {
  if (startedMs === null || endedMs === null) {
    return null;
  }
  const secs = Math.floor((endedMs - startedMs) / 1000);
  if (secs < 1) {
    return null;
  }
  if (secs < 60) {
    return `${secs}s`;
  }
  const mins = Math.floor(secs / 60);
  if (mins < 60) {
    return `${mins}m ${secs % 60}s`;
  }
  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

/** "10:42": when a prompt was sent, in the user's own clock. */
export function clockLabel(ms: number): string {
  return new Date(ms).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** A stretch of a turn: one of Claude's messages, or the steps between two. */
export type TurnSection =
  | { kind: "text"; text: string }
  | { items: TurnItem[]; kind: "steps" };

/** A turn's "What Claude did" cut at each message Claude wrote mid-turn, so
 *  the messages read in place and only the steps between them fold. */
export function turnSections(did: TurnItem[]): TurnSection[] {
  const sections: TurnSection[] = [];
  for (const item of did) {
    if (item.kind === "text") {
      sections.push({ kind: "text", text: item.text });
      continue;
    }
    // biome-ignore lint/style/useAtIndex: project lib is ES2020; Array.prototype.at is unavailable.
    const last = sections[sections.length - 1];
    if (last?.kind === "steps") {
      last.items.push(item);
    } else {
      sections.push({ items: [item], kind: "steps" });
    }
  }
  return sections;
}

/** What each kind of step is doing, and the noun when its target is unknown. */
const DOING: Record<StepKind, [string, string]> = {
  agent: ["Running", "a subagent"],
  command: ["Running", "a command"],
  edit: ["Editing", "a file"],
  mcp: ["Calling", "an MCP tool"],
  other: ["Using", ""],
  read: ["Reading", "a file"],
  search: ["Searching for", "files"],
  web: ["Fetching", "a web page"],
  write: ["Writing", "a file"],
};

/** "Reading app.ts", "Run the test suite": a step as the line under the
 *  working spinner, in Claude's own words when the tool carries them (a
 *  command's or a subagent's `description`). */
export function stepActivity(
  item: Extract<TurnItem, { kind: "step" }>
): string {
  if (item.description !== null) {
    return item.description;
  }
  const [verb, noun] = DOING[item.stepKind];
  return `${verb} ${item.target ?? (noun || item.name)}`;
}

/** The step `turn` is in the middle of, in plain words ({@link stepActivity});
 *  `null` once the turn is over or stopped — a step cut short by Esc never
 *  gets its result, but isn't running. */
export function stepInProgress(
  turn: StructuredTurn | undefined
): string | null {
  if (turn === undefined || turn.ended || turn.interrupted) {
    return null;
  }
  // biome-ignore lint/style/useAtIndex: project lib is ES2020; Array.prototype.at is unavailable.
  const last = turn.did[turn.did.length - 1];
  return last?.kind === "step" && last.result === null
    ? stepActivity(last)
    : null;
}
