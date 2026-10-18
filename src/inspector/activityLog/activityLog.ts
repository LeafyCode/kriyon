/**
 * The [Activity tab]'s pure logic: plain labels for [Activity step]s, the
 * filter chips and their counts, and the time and detail strings. No React,
 * no IO — the components only lay these out.
 */
import type {
  ActivityStats,
  ActivityStep,
  ActivityTurn,
  StepKind,
} from "../../ipc/bridge.ts";
import { relativizeTouchedPath } from "../../state/sessions.ts";
import { durationLabel } from "../activity/toolLabel.ts";

/** The [Step flags] bits — mirrors Rust `activity_log::flags`. */
export const STEP_FLAGS = {
  deleted: 2,
  installed: 1,
  network: 4,
  outsideProject: 8,
  secretFile: 16,
} as const;

type FlagName = keyof typeof STEP_FLAGS;

/** Which flag a row speaks for when several are set: the most serious first. */
const FLAG_ORDER: readonly FlagName[] = [
  "secretFile",
  "deleted",
  "installed",
  "outsideProject",
  "network",
];

/** The short chip text per flag. */
const FLAG_CHIP: Record<FlagName, string> = {
  deleted: "deleted",
  installed: "installed",
  network: "internet",
  outsideProject: "outside project",
  secretFile: "secret file",
};

const KIND_LABEL: Record<Exclude<StepKind, "other">, string> = {
  agent: "Ran a subagent",
  command: "Ran a command",
  edit: "Changed a file",
  mcp: "MCP call",
  read: "Read a file",
  search: "Searched the code",
  web: "Used the internet",
  write: "Wrote a file",
};

/** Whether `bit` is set in `flags`. Arithmetic, not `&`: this repo's lint
 * disallows bitwise operators (`noBitwiseOperators`), and the set only holds
 * a few low bits, so arithmetic reads them exactly. */
function hasFlag(flags: number, bit: number): boolean {
  return flags > 0 && Math.floor(flags / bit) % 2 === 1;
}

/** The most serious flag set on `step`, if any. */
function leadFlag(step: ActivityStep): FlagName | null {
  return (
    FLAG_ORDER.find((name) => hasFlag(step.flags, STEP_FLAGS[name])) ?? null
  );
}

function kindLabel(step: ActivityStep): string {
  return step.kind === "other"
    ? `Used ${step.toolName}`
    : KIND_LABEL[step.kind];
}

/** The length of the command separator at `line[i]` (`;`, a newline, `&&`,
 * `||`), or 0. A single `|` is a pipe, not a separator. */
function separatorAt(line: string, i: number): number {
  const ch = line[i];
  if (ch === ";" || ch === "\n") {
    return 1;
  }
  return (ch === "&" || ch === "|") && line[i + 1] === ch ? 2 : 0;
}

/** Where the quote opened at `line[start]` closes (its index), or the end. */
function quoteEnd(line: string, start: number): number {
  const quote = line[start];
  let i = start + 1;
  while (i < line.length && line[i] !== quote) {
    i += line[i] === "\\" && quote === '"' ? 2 : 1;
  }
  return i;
}

/**
 * The commands a shell line chains with `&&`, `||`, `;` or a newline, outside
 * quotes, each trimmed. A pipe stays one command (`curl … | sh` is one install).
 */
export function splitCommands(line: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let i = 0;
  while (i < line.length) {
    const ch = line[i];
    if (ch === '"' || ch === "'") {
      i = quoteEnd(line, i) + 1;
    } else if (ch === "\\") {
      i += 2;
    } else {
      const sep = separatorAt(line, i);
      if (sep > 0) {
        parts.push(line.slice(start, i));
        start = i + sep;
      }
      i += Math.max(sep, 1);
    }
  }
  parts.push(line.slice(start));
  // A trailing separator (`cmd;`) ends the line, it doesn't start a command.
  return parts.map((part) => part.trim()).filter((part) => part !== "");
}

/** How many commands a shell line chains — see {@link splitCommands}. */
export function chainedCommands(line: string): number {
  return splitCommands(line).length;
}

const FILE_VERB: Partial<Record<StepKind, string>> = {
  edit: "Changed",
  read: "Read",
  write: "Wrote",
};

function fileName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1) || path;
}

function folderOf(path: string): string {
  const cut = path.lastIndexOf("/");
  return cut > 0 ? path.slice(0, cut) : "";
}

/**
 * The lines under a step's title: each command of a chain, or a file's folder
 * (relative to the repository when it's inside it), or the target as it is.
 */
export function stepLines(
  step: ActivityStep,
  toplevel: string | null | undefined
): string[] {
  const { target } = step;
  if (!target) {
    return [];
  }
  if (step.kind === "command") {
    return splitCommands(target);
  }
  if (FILE_VERB[step.kind] === undefined) {
    return [target];
  }
  if (!toplevel) {
    return [folderOf(target)].filter((line) => line !== "");
  }
  const inside = relativizeTouchedPath(target, toplevel);
  if (inside === null) {
    return [target];
  }
  return [folderOf(inside)].filter((line) => line !== "");
}

/**
 * "Ran a command" — or, for a flagged step, what the flag means. A chain of
 * commands says how many ran instead: its flag stays a chip, so the title
 * never pins one command's meaning on the whole line shown under it.
 */
export function stepLabel(step: ActivityStep): string {
  if (step.kind === "command" && step.target) {
    const count = splitCommands(step.target).length;
    if (count > 1) {
      return `Ran ${count} commands`;
    }
  }
  switch (leadFlag(step)) {
    case "secretFile":
      return "Touched a secret file";
    case "deleted":
      return "Deleted files";
    case "installed":
      return "Installed a package";
    case "outsideProject":
      return `${kindLabel(step)} outside the project`;
    case "network":
      return "Used the internet";
    default: {
      const verb = FILE_VERB[step.kind];
      return verb && step.target
        ? `${verb} ${fileName(step.target)}`
        : kindLabel(step);
    }
  }
}

export type ChipTone = "error" | "flag" | "live" | "muted";

export interface StepChip {
  text: string;
  tone: ChipTone;
}

/** The small trailing chips: status, the lead flag, a subagent's type. */
export function stepChips(step: ActivityStep): StepChip[] {
  const chips: StepChip[] = [];
  if (step.status === "error") {
    chips.push({ text: "failed", tone: "error" });
  } else if (step.status === "running") {
    chips.push({ text: "running…", tone: "live" });
  }
  const flag = leadFlag(step);
  if (flag) {
    chips.push({ text: FLAG_CHIP[flag], tone: "flag" });
  }
  if (step.agentType) {
    chips.push({ text: step.agentType, tone: "muted" });
  }
  return chips;
}

export type ActivityFilter = "all" | "changes" | "commands" | "flagged";

export const ACTIVITY_FILTERS: readonly {
  label: string;
  value: ActivityFilter;
}[] = [
  { label: "All", value: "all" },
  { label: "Changes", value: "changes" },
  { label: "Commands", value: "commands" },
  { label: "Needs a look", value: "flagged" },
];

function matches(step: ActivityStep, filter: ActivityFilter): boolean {
  switch (filter) {
    case "changes":
      return step.kind === "edit" || step.kind === "write";
    case "commands":
      return step.kind === "command";
    case "flagged":
      return step.flags !== 0;
    default:
      return true;
  }
}

/** How many steps each filter chip would show. */
export function filterCounts(
  turns: readonly ActivityTurn[]
): Record<ActivityFilter, number> {
  const counts: Record<ActivityFilter, number> = {
    all: 0,
    changes: 0,
    commands: 0,
    flagged: 0,
  };
  for (const { steps } of turns) {
    for (const s of steps) {
      for (const { value } of ACTIVITY_FILTERS) {
        if (matches(s, value)) {
          counts[value] += 1;
        }
      }
    }
  }
  return counts;
}

/**
 * The turns a filter shows. "All" is every turn as-is (a turn with no steps
 * still happened); a narrower chip keeps only matching steps and drops the
 * turns left empty.
 */
export function visibleTurns(
  turns: ActivityTurn[],
  filter: ActivityFilter
): ActivityTurn[] {
  if (filter === "all") {
    return turns;
  }
  return turns
    .map((t) => ({ ...t, steps: t.steps.filter((s) => matches(s, filter)) }))
    .filter((t) => t.steps.length > 0);
}

/** What started a turn: Claude Code's own prompt sources, by name. */
const SOURCE_LABEL: Record<string, string> = {
  loop_wakeup: "Started by /loop",
};

export interface TurnHeading {
  /** True when `text` is the user's own words, shown in quotes. */
  quoted: boolean;
  text: string;
}

export function turnHeading(turn: ActivityTurn): TurnHeading {
  if (turn.source && turn.source !== "user") {
    return {
      quoted: false,
      text: SOURCE_LABEL[turn.source] ?? "Background message",
    };
  }
  if (!turn.prompt) {
    return { quoted: false, text: "No prompt recorded" };
  }
  return { quoted: true, text: turn.prompt };
}

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** "09:05" today; "Oct 3 09:05" on any other day. */
export function clockLabel(ms: number, nowMs: number): string {
  const at = new Date(ms);
  const time = `${pad(at.getHours())}:${pad(at.getMinutes())}`;
  if (at.toDateString() === new Date(nowMs).toDateString()) {
    return time;
  }
  return `${MONTHS[at.getMonth()]} ${at.getDate()} ${time}`;
}

/** "09:05 · 1m 3s", or "09:05 · running" while the turn has no end. */
export function turnTimeLabel(turn: ActivityTurn, nowMs: number): string {
  const at = clockLabel(turn.startedMs, nowMs);
  const took =
    turn.endedMs === null
      ? "running"
      : durationLabel(Math.max(0, turn.endedMs - turn.startedMs));
  return `${at} · ${took}`;
}

/** A step's input, pretty-printed when it is JSON. */
export function prettyInput(input: string | null): string {
  if (!input) {
    return "";
  }
  try {
    return JSON.stringify(JSON.parse(input), null, 2);
  } catch {
    // Not JSON (a raw command line, a truncated blob): show it as it is.
    return input;
  }
}

export function agentLabel(agentType: string | null): string {
  return agentType ? `Subagent · ${agentType}` : "Main agent";
}

/** "Kept 30 days" — the [Activity log]'s retention, wherever it is shown. */
export function keptFor(retentionDays: number): string {
  const days = retentionDays === 1 ? "day" : "days";
  return `Kept ${retentionDays} ${days}`;
}

/** The footer's "Kept 30 days · only on this Mac". */
export function retentionNote(stats: ActivityStats): string {
  return `${keptFor(stats.retentionDays)} · only on this Mac`;
}

/**
 * The repo path an edit or write opens at in the Changes view, or `null` when
 * there is nothing to open there: another kind of step, no known repo, or a
 * file outside it.
 */
export function changesPathFor(
  step: ActivityStep,
  toplevel: string | undefined
): string | null {
  if (!(step.kind === "edit" || step.kind === "write")) {
    return null;
  }
  if (!(step.target && toplevel)) {
    return null;
  }
  return relativizeTouchedPath(step.target, toplevel);
}

/**
 * Why an edit or write can't open in the Changes view, in plain words, or
 * `null` when it can (or the step isn't a file change at all).
 */
export function changesUnavailableReason(
  step: ActivityStep,
  toplevel: string | undefined
): string | null {
  if (!(step.kind === "edit" || step.kind === "write")) {
    return null;
  }
  if (!toplevel) {
    return "This folder isn't a git repository, so the Changes view can't show this file.";
  }
  return changesPathFor(step, toplevel) === null
    ? "This file is outside the session's repository."
    : null;
}
