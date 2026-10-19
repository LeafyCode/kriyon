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
  network: "web",
  outsideProject: "outside",
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

/** Plain words for Claude Code's own tools that name no file or command. */
const TOOL_LABEL: Record<string, string> = {
  AskUserQuestion: "Asked you a question",
  CronCreate: "Scheduled a task",
  CronDelete: "Cancelled a scheduled task",
  CronList: "Checked the scheduled tasks",
  EnterPlanMode: "Started planning",
  EnterWorktree: "Moved to a worktree",
  ExitPlanMode: "Proposed a plan",
  ExitWorktree: "Left the worktree",
  Glob: "Looked for files",
  LSP: "Looked up code",
  Monitor: "Watched a command",
  PushNotification: "Sent you a notification",
  ScheduleWakeup: "Scheduled a check-in",
  SendMessage: "Sent a message to an agent",
  SubagentHandback: "Reported back",
  TaskCreate: "Added a task",
  TaskGet: "Checked a task",
  TaskList: "Checked the tasks",
  TaskOutput: "Read a background task's output",
  TaskStop: "Stopped a background task",
  TaskUpdate: "Updated a task",
  TodoWrite: "Updated the to-do list",
  ToolSearch: "Loaded more tools",
  WebSearch: "Searched the web",
};

/** The past tense of the verbs Claude starts a description with, so "Run the
 * tests" reads as what happened: "Ran the tests". A description starting
 * with any other word stays as Claude wrote it. */
const PAST: Record<string, string> = {
  add: "added",
  analyze: "analyzed",
  append: "appended",
  apply: "applied",
  build: "built",
  bump: "bumped",
  check: "checked",
  clean: "cleaned",
  clone: "cloned",
  commit: "committed",
  compare: "compared",
  compile: "compiled",
  confirm: "confirmed",
  convert: "converted",
  copy: "copied",
  count: "counted",
  create: "created",
  delete: "deleted",
  describe: "described",
  diff: "diffed",
  download: "downloaded",
  dump: "dumped",
  ensure: "ensured",
  examine: "examined",
  explore: "explored",
  export: "exported",
  extract: "extracted",
  fetch: "fetched",
  find: "found",
  fix: "fixed",
  format: "formatted",
  generate: "generated",
  get: "got",
  grep: "grepped",
  import: "imported",
  init: "initialized",
  inspect: "inspected",
  install: "installed",
  investigate: "investigated",
  kill: "killed",
  launch: "launched",
  lint: "linted",
  list: "listed",
  load: "loaded",
  locate: "located",
  look: "looked",
  make: "made",
  measure: "measured",
  merge: "merged",
  move: "moved",
  open: "opened",
  print: "printed",
  probe: "probed",
  pull: "pulled",
  push: "pushed",
  query: "queried",
  read: "read",
  rebase: "rebased",
  rebuild: "rebuilt",
  remove: "removed",
  rename: "renamed",
  render: "rendered",
  replace: "replaced",
  rerun: "reran",
  rewrite: "rewrote",
  reset: "reset",
  restart: "restarted",
  restore: "restored",
  revert: "reverted",
  review: "reviewed",
  run: "ran",
  save: "saved",
  scan: "scanned",
  search: "searched",
  show: "showed",
  stage: "staged",
  start: "started",
  stash: "stashed",
  stop: "stopped",
  summarize: "summarized",
  uninstall: "uninstalled",
  switch: "switched",
  sync: "synced",
  test: "tested",
  update: "updated",
  upgrade: "upgraded",
  upload: "uploaded",
  validate: "validated",
  verify: "verified",
  view: "viewed",
  wait: "waited",
  watch: "watched",
  write: "wrote",
};

/** Verbs that read as nouns after "and" ("…and test files"): only the
 * first word of a description takes their past tense. */
const NOUN_TOO = new Set([
  "build",
  "count",
  "diff",
  "dump",
  "export",
  "format",
  "import",
  "list",
  "push",
  "query",
  "reset",
  "save",
  "scan",
  "search",
  "stage",
  "start",
  "stop",
  "sync",
  "test",
  "update",
  "view",
  "watch",
]);

/** The first word of a description, and each word that opens a clause after
 * it (after a comma, "and" or "then"). */
const CLAUSE_VERB = /(^|, |; | and | then )([A-Za-z]+)/g;

/** `text` with the verb of each clause in the past tense, when {@link PAST}
 * knows it: "Install dayjs and check it" → "Installed dayjs and checked it". */
function pastTense(text: string): string {
  return text.replace(CLAUSE_VERB, (whole, before: string, word: string) => {
    const lower = word.toLowerCase();
    const past = PAST[lower];
    if (!past || (before !== "" && NOUN_TOO.has(lower))) {
      return whole;
    }
    const capital = word[0] !== word[0].toLowerCase();
    return before + (capital ? past[0].toUpperCase() + past.slice(1) : past);
  });
}

/** A command that takes a package off the machine (`npm uninstall`, …). */
const UNINSTALL =
  /\b(?:(?:npm|pnpm|yarn|bun)\s+(?:uninstall|remove|rm|un)|pip3?\s+uninstall|uv\s+remove|brew\s+(?:uninstall|remove)|cargo\s+(?:remove|uninstall)|gem\s+uninstall|apt(?:-get)?\s+(?:remove|purge))\b/;

/** Tools whose summary is for the model, not the person (`select:Read`). */
const QUIET_SUMMARY = new Set(["ToolSearch"]);

function kindLabel(step: ActivityStep): string {
  const named = TOOL_LABEL[step.toolName];
  if (named) {
    return named;
  }
  return step.kind === "other"
    ? `Used ${step.toolName}`
    : KIND_LABEL[step.kind];
}

/** A step's summary when it is for the person, not the model. */
function spokenSummary(step: ActivityStep): string | null {
  return step.summary && !QUIET_SUMMARY.has(step.toolName)
    ? step.summary
    : null;
}

/** The title Claude's own words give a step, or `null` when they give none:
 * a command's description ("Ran the tests"), a subagent's task, a skill. */
function describedLabel(step: ActivityStep): string | null {
  const summary = spokenSummary(step);
  if (!summary) {
    return null;
  }
  if (step.kind === "command") {
    return pastTense(summary);
  }
  if (step.kind === "agent") {
    return `Subagent: ${summary}`;
  }
  return step.toolName === "Skill" ? `Used the ${summary} skill` : null;
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

/**
 * Where the command holding the heredoc opened at `line[start]` (`<<EOF`,
 * `<<-'EOF'`, `<<"EOF"`) goes on: the newline after its closing word, or the
 * end. -1 when `<<` there opens no heredoc (`<<<` is a here-string).
 */
function heredocEnd(line: string, start: number): number {
  const word = HEREDOC.exec(line.slice(start))?.[1];
  if (!word) {
    return -1;
  }
  let at = line.indexOf("\n", start);
  while (at !== -1) {
    const next = line.indexOf("\n", at + 1);
    const body = line.slice(at + 1, next === -1 ? undefined : next);
    if (body.trim() === word) {
      return next === -1 ? line.length : next;
    }
    at = next;
  }
  return line.length;
}

const HEREDOC = /^<<-?\s*['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?/;

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
 * quotes and heredocs, each trimmed. A pipe stays one command (`curl … | sh`
 * is one install).
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
    } else if (ch === "<" && heredocEnd(line, i) !== -1) {
      // A heredoc's body is the command's input, not more commands.
      i = heredocEnd(line, i);
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
  return joinBlocks(
    parts.map((part) => part.trim()).filter((part) => part !== "")
  );
}

/** The word that closes each shell block a command can open. */
const BLOCK_CLOSE: Record<string, string> = {
  case: "esac",
  for: "done",
  if: "fi",
  select: "done",
  until: "done",
  while: "done",
};

const FIRST_WORD = /^\S+/;

/** The parts of a loop or `if` put back together: `for f in *; do …; done`
 * is one command, not three. */
function joinBlocks(parts: string[]): string[] {
  const commands: string[] = [];
  const open: string[] = [];
  let block: string[] = [];
  for (const part of parts) {
    block.push(part);
    const word = FIRST_WORD.exec(part)?.[0] ?? "";
    // `open` holds the closing words still owed, innermost first.
    if (BLOCK_CLOSE[word]) {
      open.unshift(BLOCK_CLOSE[word]);
    } else if (word === open[0]) {
      open.shift();
    }
    if (open.length === 0) {
      commands.push(block.join("; "));
      block = [];
    }
  }
  if (block.length > 0) {
    commands.push(block.join("; "));
  }
  return commands;
}

/** How many commands a shell line chains — see {@link splitCommands}. */
export function chainedCommands(line: string): number {
  return splitCommands(line).length;
}

const FILE_VERB: Partial<Record<StepKind, string>> = {
  edit: "Changed",
  read: "Read",
  write: "Changed",
};

/** "Added" for a write that made a new file, else the kind's verb. */
function fileVerb(step: ActivityStep): string | undefined {
  return step.kind === "write" && step.created ? "Added" : FILE_VERB[step.kind];
}

function fileName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1) || path;
}

function folderOf(path: string): string {
  const cut = path.lastIndexOf("/");
  return cut > 0 ? path.slice(0, cut) : "";
}

/** The scheme a fetched address starts with, left off where it's shown. */
const WEB_SCHEME = /^https?:\/\//;

/** The most lines a chain shows before it says how many more ran. */
const MAX_COMMAND_LINES = 4;

/** A home folder anywhere in a line: `/Users/<name>/`. Mac-first. */
const HOME_PATH = /\/Users\/[^/\s'"]+\//g;

/** The most file names a row lists before it counts the rest. */
const MAX_FOLDED_NAMES = 3;

/** "a.js, b.js, c.js +2": the first few names of `paths`, the rest counted. */
function namesLine(paths: readonly string[]): string {
  const names = paths.slice(0, MAX_FOLDED_NAMES).map(fileName).join(", ");
  const more = paths.length - MAX_FOLDED_NAMES;
  return more > 0 ? `${names} +${more}` : names;
}

/** "Changed a.js, b.js" for the files a command changed, if any. */
function changedLine(paths: readonly string[]): string[] {
  return paths.length > 0 ? [`Changed ${namesLine(paths)}`] : [];
}

/** Each command of a chain by its first line, the rest counted. */
function commandLines(target: string): string[] {
  const lines = splitCommands(target).map((command) => {
    const cut = command.indexOf("\n");
    return cut === -1 ? command : `${command.slice(0, cut).trimEnd()} …`;
  });
  if (lines.length <= MAX_COMMAND_LINES) {
    return lines;
  }
  const shown = MAX_COMMAND_LINES - 1;
  return [...lines.slice(0, shown), `+${lines.length - shown} more`];
}

/**
 * The lines under a step's title, home folders shortened to `~`: each command
 * of a chain, or a file's folder (relative to the repository when it's inside
 * it), or what a tool with a fixed title was about, or the target as it is.
 */
export function stepLines(
  step: ActivityStep,
  toplevel: string | null | undefined
): string[] {
  return rawLines(step, toplevel).map((line) => line.replace(HOME_PATH, "~/"));
}

function rawLines(
  step: ActivityStep,
  toplevel: string | null | undefined
): string[] {
  const { target, toolName } = step;
  const summary = spokenSummary(step);
  if (summary && step.kind === "search") {
    // What it looked for, and what it found: "“UsageSnapshot” · 6 files".
    return [[`“${summary}”`, step.outcome].filter(Boolean).join(" · ")];
  }
  if (summary && toolName === "WebSearch") {
    return [`“${summary}”`];
  }
  if (summary && toolName === "WebFetch") {
    return [summary.replace(WEB_SCHEME, "")];
  }
  if (!target && summary && TOOL_LABEL[toolName]) {
    return [summary];
  }
  if (!target) {
    return [];
  }
  if (step.kind === "command") {
    return [...commandLines(target), ...changedLine(step.changedFiles)];
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
 * What the step did, plainly. What it did to the machine leads: an install,
 * a delete, a secret file, a file outside the project. Otherwise Claude's own
 * description in the past tense ("Ran the tests"), the file it changed, or
 * the kind of step. A chain of commands never takes one command's flag as its
 * title (the flag stays a chip): it says what Claude meant by it, or how many
 * commands ran.
 */
export function stepLabel(step: ActivityStep): string {
  const flag = leadFlag(step);
  const chain =
    step.kind === "command" && step.target
      ? splitCommands(step.target).length
      : 1;
  if (chain > 1) {
    return describedLabel(step) ?? `Ran ${chain} commands`;
  }
  const described = describedLabel(step);
  if (described && (flag === null || flag === "network")) {
    return described;
  }
  switch (flag) {
    case "secretFile":
      return "Touched a secret file";
    case "deleted":
      return UNINSTALL.test(step.target ?? "")
        ? "Removed a package"
        : "Deleted files";
    case "installed":
      return "Installed a package";
    case "outsideProject":
      return `${kindLabel(step)} outside the project`;
    case "network":
      return step.kind === "web" ? kindLabel(step) : "Used the internet";
    default: {
      const verb = fileVerb(step);
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

/**
 * The small trailing chips: status, the user's yes, the lead flag, a
 * subagent's type (left off when `nested` under its subagent's row). Once
 * `turnEnded`, a main-agent step whose end was never recorded isn't running:
 * Claude ends a turn only after its own calls return.
 */
export function stepChips(
  step: ActivityStep,
  turnEnded = false,
  nested = false
): StepChip[] {
  const chips: StepChip[] = [];
  const stale = turnEnded && step.agentType === null;
  if (step.status === "error") {
    chips.push({ text: "failed", tone: "error" });
  } else if (step.status === "running" && !stale) {
    chips.push({ text: "running…", tone: "live" });
  }
  if (step.approved) {
    chips.push({ text: "you approved", tone: "flag" });
  }
  const flag = leadFlag(step);
  if (flag) {
    chips.push({ text: FLAG_CHIP[flag], tone: "flag" });
  }
  // Under its subagent's row, the type would only repeat it.
  if (step.agentType && !nested) {
    chips.push({ text: step.agentType, tone: "muted" });
  }
  return chips;
}

export type StatTone = "added" | "error" | "ok" | "removed";

export interface StepStat {
  text: string;
  tone: StatTone;
}

/** "+12", "−3": the lines a file change added and removed. */
function lineStats(added: number, removed: number): StepStat[] {
  const stats: StepStat[] = [];
  if (added > 0) {
    stats.push({ text: `+${added}`, tone: "added" });
  }
  if (removed > 0) {
    stats.push({ text: `−${removed}`, tone: "removed" });
  }
  return stats;
}

/** The facts at a row's end: lines changed, and a test run's "43 passed". */
export function stepStats(step: ActivityStep): StepStat[] {
  const stats = lineStats(step.linesAdded ?? 0, step.linesRemoved ?? 0);
  if (step.kind === "command" && step.outcome) {
    const failed = step.outcome.includes("failed");
    stats.push({ text: step.outcome, tone: failed ? "error" : "ok" });
  }
  return stats;
}

/** One timeline row: a step, or a run of reads or changes folded into one. */
export interface StepRowView {
  /** A subagent's own rows, under the step that started it. */
  children?: StepRowView[];
  label: string;
  lines: string[];
  stats: StepStat[];
  /** The step itself, or every step the row folds, in order. */
  steps: ActivityStep[];
}

/** A step's own row. */
export function stepRow(
  step: ActivityStep,
  toplevel: string | null | undefined
): StepRowView {
  return {
    label: stepLabel(step),
    lines: stepLines(step, toplevel),
    stats: stepStats(step),
    steps: [step],
  };
}

type Fold = "change" | "read";

/** What run a step can fold into: a plain read or file change that went
 * fine. Anything flagged or failed keeps a row of its own, so it's seen. */
function foldOf(step: ActivityStep): Fold | null {
  if (step.flags !== 0 || step.status !== "ok" || !step.target) {
    return null;
  }
  if (step.kind === "read") {
    return "read";
  }
  return step.kind === "edit" || step.kind === "write" ? "change" : null;
}

function foldedRow(
  run: ActivityStep[],
  fold: Fold,
  toplevel: string | null | undefined
): StepRowView {
  const targets = [...new Set(run.map((s) => s.target ?? ""))];
  const stats = lineStats(
    run.reduce((n, s) => n + (s.linesAdded ?? 0), 0),
    run.reduce((n, s) => n + (s.linesRemoved ?? 0), 0)
  );
  if (targets.length === 1) {
    return { ...stepRow(run[0], toplevel), stats, steps: run };
  }
  let verb = "Read";
  if (fold === "change") {
    verb = run.every((s) => s.created) ? "Added" : "Changed";
  }
  return {
    label: `${verb} ${targets.length} files`,
    lines: [namesLine(targets)],
    stats,
    steps: run,
  };
}

/**
 * A turn's steps as timeline rows: reads in a row fold into "Read 9 files",
 * file changes into "Changed 3 files" with their lines added up. Only steps
 * of the same agent fold together.
 */
export function groupSteps(
  steps: readonly ActivityStep[],
  toplevel: string | null | undefined = null
): StepRowView[] {
  const rows: StepRowView[] = [];
  let i = 0;
  while (i < steps.length) {
    const fold = foldOf(steps[i]);
    let end = i + 1;
    while (
      fold &&
      end < steps.length &&
      foldOf(steps[end]) === fold &&
      steps[end].agentType === steps[i].agentType
    ) {
      end += 1;
    }
    const run = steps.slice(i, end);
    rows.push(
      fold && run.length > 1
        ? foldedRow(run, fold, toplevel)
        : stepRow(run[0], toplevel)
    );
    i = end;
  }
  return rows;
}

/** The subagent type Claude Code runs when a launch names none. */
const DEFAULT_SUBAGENT = "general-purpose";

/**
 * A turn's timeline: the main agent's rows ({@link groupSteps}), with each
 * subagent's steps under the step that started it — the earliest unclaimed
 * launch of its type before its first step. A subagent whose launch isn't in
 * sight (another turn, a filter) gets a block of its own, in time order.
 */
export function turnRows(
  steps: readonly ActivityStep[],
  toplevel: string | null | undefined
): StepRowView[] {
  const main = steps.filter((s) => s.agentId === null);
  const groups = new Map<string, ActivityStep[]>();
  for (const s of steps) {
    if (s.agentId !== null) {
      groups.set(s.agentId, [...(groups.get(s.agentId) ?? []), s]);
    }
  }
  const claimed = new Map<number, ActivityStep[]>();
  const orphans: ActivityStep[][] = [];
  for (const group of groups.values()) {
    const [first] = group;
    const launch = main.find(
      (s) =>
        s.kind === "agent" &&
        !claimed.has(s.id) &&
        (s.launchedType ?? DEFAULT_SUBAGENT) === first.agentType &&
        s.startedMs <= first.startedMs
    );
    if (launch) {
      claimed.set(launch.id, group);
    } else {
      orphans.push(group);
    }
  }
  const rows = groupSteps(main, toplevel).map((row) => {
    const group = claimed.get(row.steps[0].id);
    return group ? withChildren(row, group, toplevel) : row;
  });
  for (const group of orphans) {
    const row = withChildren(
      {
        label: `Subagent · ${group[0].agentType ?? "unknown"}`,
        lines: [],
        stats: [],
        steps: group,
      },
      group,
      toplevel
    );
    const at = rows.findIndex((r) => r.steps[0].startedMs > group[0].startedMs);
    rows.splice(at === -1 ? rows.length : at, 0, row);
  }
  return rows;
}

/** `row` with a subagent's rows under it, and their lines added up. */
function withChildren(
  row: StepRowView,
  group: ActivityStep[],
  toplevel: string | null | undefined
): StepRowView {
  return {
    ...row,
    children: groupSteps(group, toplevel),
    stats: lineStats(
      group.reduce((n, s) => n + (s.linesAdded ?? 0), 0),
      group.reduce((n, s) => n + (s.linesRemoved ?? 0), 0)
    ),
  };
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

/** Claude Code's own housekeeping, which does nothing on the machine:
 * loading more of its tools. Left out of the timeline and its counts. */
const HOUSEKEEPING = new Set(["ToolSearch"]);

function matches(step: ActivityStep, filter: ActivityFilter): boolean {
  if (HOUSEKEEPING.has(step.toolName)) {
    return false;
  }
  switch (filter) {
    case "changes":
      // A command that edited files changed them too (`sed -i`, a codemod).
      return (
        step.kind === "edit" ||
        step.kind === "write" ||
        (step.linesAdded ?? 0) + (step.linesRemoved ?? 0) > 0
      );
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
 * The turns a filter shows, each with only its matching steps. "All" keeps
 * every turn (a turn with no steps still happened); a narrower chip drops the
 * turns left empty.
 */
export function visibleTurns(
  turns: ActivityTurn[],
  filter: ActivityFilter
): ActivityTurn[] {
  const kept = turns.map((t) => ({
    ...t,
    steps: t.steps.filter((s) => matches(s, filter)),
  }));
  return filter === "all" ? kept : kept.filter((t) => t.steps.length > 0);
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
  if (turn.report) {
    return { quoted: false, text: turn.report };
  }
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

/** `text` parsed as a JSON object, or `null` when it is anything else. */
function jsonObject(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    // Not JSON (a raw command line, a truncated blob).
    return null;
  }
}

/** A step's input as a person reads it: a command as its own text, anything
 * else pretty-printed when it is JSON. */
export function prettyInput(input: string | null): string {
  if (!input) {
    return "";
  }
  const value = jsonObject(input);
  if (!value) {
    return input;
  }
  return typeof value.command === "string"
    ? value.command
    : JSON.stringify(value, null, 2);
}

/** A step's result as a person reads it: a command's output, not the JSON
 * an older hook wrapped it in. */
export function prettyResult(result: string | null): string {
  if (!result) {
    return "";
  }
  const value = jsonObject(result);
  const output = [value?.stdout, value?.stderr].filter(
    (t): t is string => typeof t === "string" && t !== ""
  );
  return value && ("stdout" in value || "stderr" in value)
    ? output.join("\n")
    : result;
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
