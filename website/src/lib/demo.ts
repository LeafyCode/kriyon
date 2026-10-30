/**
 * The demo record the page shows: one afternoon in the `orbit-web` demo
 * project (`/Users/Shared/kriyon-demo`). Nothing here comes from a real
 * client project, and the screenshots were taken from the same demo.
 */
import type { ShotName } from "./shots.ts";

/** One colour per kind of thing Claude did, used the same way everywhere. */
export type Tone = "change" | "look" | "ok";

export interface TickerEvent {
  text: string;
  time: string;
  tone: Tone;
}

export const TICKER: readonly TickerEvent[] = [
  {
    time: "10:42:03",
    text: "INSTALLED A PACKAGE · pnpm add date-fns",
    tone: "look",
  },
  { time: "10:42:09", text: "USED THE INTERNET · date-fns.org", tone: "look" },
  { time: "10:42:31", text: "CHANGED UsageFooter.tsx +12 −3", tone: "change" },
  { time: "10:42:48", text: "ADDED UsageFooter.test.tsx +41", tone: "change" },
  { time: "10:43:10", text: "RAN THE TESTS · 43 PASSED", tone: "ok" },
  {
    time: "10:43:22",
    text: "STARTED A NESTED SESSION · Fix the flaky date test",
    tone: "ok",
  },
  {
    time: "10:44:02",
    text: "READ ~/.claude/settings.json · OUTSIDE PROJECT",
    tone: "look",
  },
  {
    time: "10:44:40",
    text: "WEEKLY LIMIT · RUNS OUT IN ABOUT 9H AT THIS RATE",
    tone: "look",
  },
];

export type Filter = "all" | "changes" | "commands" | "look";

export interface ActivityRow {
  detail: string;
  kinds: readonly Exclude<Filter, "all">[];
  result: string;
  title: string;
  tone: Tone;
  turn: string;
}

export const ACTIVITY: readonly ActivityRow[] = [
  {
    turn: "T2 · 10:42",
    title: "Installed a package",
    detail: "pnpm add date-fns",
    result: "NEW PACKAGE",
    kinds: ["commands", "look"],
    tone: "look",
  },
  {
    turn: "T2 · 10:42",
    title: "Used the internet",
    detail: "date-fns.org/docs/formatDistance",
    result: "NETWORK",
    kinds: ["look"],
    tone: "look",
  },
  {
    turn: "T2 · 10:43",
    title: "Changed UsageFooter.tsx",
    detail: "src/sidebar",
    result: "+12 −3",
    kinds: ["changes"],
    tone: "change",
  },
  {
    turn: "T2 · 10:43",
    title: "Added UsageFooter.test.tsx",
    detail: "src/sidebar",
    result: "+41",
    kinds: ["changes"],
    tone: "change",
  },
  {
    turn: "T2 · 10:43",
    title: "Ran the tests",
    detail: "pnpm test usage",
    result: "43 PASSED",
    kinds: ["commands"],
    tone: "ok",
  },
  {
    turn: "T1 · 10:31",
    title: "Read a file outside the project",
    detail: "~/.claude/settings.json",
    result: "OUTSIDE PROJECT",
    kinds: ["look"],
    tone: "look",
  },
  {
    turn: "T1 · 10:32",
    title: "Changed 3 files",
    detail: "usage.rs, hooks.rs, UsageFooter.tsx",
    result: "+88 −14",
    kinds: ["changes"],
    tone: "change",
  },
  {
    turn: "T1 · 10:33",
    title: "Ran the tests",
    detail: "cargo test -p kriyon-core",
    result: "212 PASSED",
    kinds: ["commands"],
    tone: "ok",
  },
];

export const FILTERS: readonly { flag: string; id: Filter }[] = [
  { id: "all", flag: "--all" },
  { id: "changes", flag: "--changes" },
  { id: "commands", flag: "--commands" },
  { id: "look", flag: "--needs-a-look" },
];

export function rowsFor(
  filter: Filter,
  rows: readonly ActivityRow[] = ACTIVITY
): ActivityRow[] {
  return rows.filter((r) => filter === "all" || r.kinds.includes(filter));
}

export interface View {
  alt: string;
  code: string;
  flag: string;
  id: string;
  isNew?: boolean;
  /** Degrees the card leans when it drops in. */
  lean: number;
  shot: ShotName;
  text: string;
}

export const VIEWS: readonly View[] = [
  {
    id: "session",
    code: "VIEW.01",
    flag: "-t, --session",
    lean: -2,
    shot: "session",
    text: "Your own claude in a real terminal. Colours, vim, ssh, everything works.",
    alt: "The Session tab: Claude Code running in a real terminal",
  },
  {
    id: "structured",
    code: "VIEW.02",
    flag: "-s, --structured",
    lean: 1.5,
    shot: "structured",
    text: "The session as messages and steps. Claude Code dialogs open over it.",
    alt: "The Structured view: the session as messages",
  },
  {
    id: "changes",
    code: "VIEW.03",
    flag: "-c, --changes",
    lean: -1.5,
    shot: "changes",
    text: "A diff of every file this session touched, since the moment it started.",
    alt: "The Changes view: a diff of every file the session touched",
  },
  {
    id: "activity",
    code: "VIEW.04",
    flag: "-a, --activity",
    isNew: true,
    lean: 2,
    shot: "activity",
    text: "What Claude did to your machine, with anything unusual flagged.",
    alt: "The Activity tab: deleted files flagged for a look",
  },
  {
    id: "menu-bar",
    code: "VIEW.05",
    flag: "-m, --menu-bar",
    lean: -1,
    shot: "menu-bar",
    text: "Which sessions need you, from anywhere on your desktop.",
    alt: "The menu bar panel: one session needs you, one is running",
  },
];

export type SessionState = "WORKING" | "NEEDS YOU" | "DONE";

export interface DemoSession {
  last: string;
  name: string;
  /** Started by the session above it, and listed under it. */
  nested?: boolean;
  project: string;
  state: SessionState;
  /** Its task list, as the row shows it: "3/5". */
  tasks?: string;
}

export const SESSIONS: readonly DemoSession[] = [
  {
    name: "Show plan limits in footer",
    project: "orbit-web",
    state: "WORKING",
    tasks: "3/5",
    last: "RAN THE TESTS · 43 PASSED",
  },
  {
    name: "Fix the flaky date test",
    nested: true,
    project: "orbit-web",
    state: "WORKING",
    last: "STARTED BY Show plan limits in footer · ON ITS OWN WORKTREE",
  },
  {
    name: "Welcome screen copy",
    project: "orbit-web",
    state: "NEEDS YOU",
    last: "WANTS TO RUN npm install · ANSWER IN ITS TERMINAL",
  },
  {
    name: "Prune old event logs",
    project: "orbit-api",
    state: "DONE",
    last: "DELETED 2 FILES · src/legacy",
  },
];

export const STACK: readonly {
  head: string;
  items: readonly string[];
  tone: Tone | "ink";
}[] = [
  {
    head: "CORE · RUST",
    tone: "change",
    items: ["kriyon-core", "portable-pty", "notify", "rusqlite"],
  },
  {
    head: "SHELL",
    tone: "ok",
    items: ["Tauri 2", "macOS 13+", "Signed DMG", "Updates itself"],
  },
  {
    head: "INTERFACE",
    tone: "look",
    items: ["React", "TypeScript", "xterm.js", "Geist + JetBrains Mono"],
  },
  {
    head: "TOOLING",
    tone: "ink",
    items: ["Biome", "Clippy (pedantic)", "Vitest", "Lefthook"],
  },
];
