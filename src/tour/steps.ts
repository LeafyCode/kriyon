import {
  BookMarked,
  Command,
  FolderTree,
  LayoutPanelLeft,
  ListChecks,
  type LucideIcon,
  Maximize2,
  MessageSquareText,
  NotebookPen,
  PanelRight,
  Plus,
  Settings,
  Sparkles,
  SquareTerminal,
} from "lucide-react";
import welcomeHero from "../assets/tour-welcome.jpg";
import type { InspectorTab } from "../state/layout.ts";
import type { CardSide } from "./placement.ts";

/**
 * One stop on the [App tour]. `target` names the `data-tour` attribute of the
 * part of the window it points at; a step without one, or whose target is
 * not on screen (no session open yet, a collapsed sidebar), shows its card in
 * the middle of the window instead.
 */
export interface TourStep {
  body: string;
  icon: LucideIcon;
  id: string;
  /** A picture across the top of the card, which then shows wider. */
  image?: string;
  /** The Details rail tab this step opens, so the person sees it. */
  inspectorTab?: InspectorTab;
  /** Shortcut keycaps shown under the body. */
  keys?: readonly string[];
  /** The side of the target the card prefers. */
  side?: CardSide;
  target?: string;
  title: string;
}

/** The `data-tour` value that marks an element as a tour stop. */
export function tourTarget(step: TourStep): string | null {
  return step.target ? `[data-tour="${step.target}"]` : null;
}

export const TOUR_STEPS: readonly TourStep[] = [
  {
    body: "Kriyon runs your own Claude Code in a real terminal, with every change it makes in view. Here is a one-minute look around.",
    icon: Sparkles,
    id: "welcome",
    image: welcomeHero,
    title: "Welcome to Kriyon",
  },
  {
    body: "Every session sits under its project folder. Click one to open it, drag to reorder. The dot beside it says whether Claude is working, waiting for you or done.",
    icon: FolderTree,
    id: "sidebar",
    side: "right",
    target: "sidebar",
    title: "Projects and sessions",
  },
  {
    body: "Pick a folder and Kriyon starts Claude Code there. A worktree session gets its own branch, so work running side by side never collides.",
    icon: Plus,
    id: "new-session",
    keys: ["⌘N"],
    side: "right",
    target: "new-session",
    title: "Start a session",
  },
  {
    body: "Command center lists every session that needs you, across all projects. Prompts keeps the prompts you send again and again.",
    icon: BookMarked,
    id: "views",
    side: "right",
    target: "views-nav",
    title: "Command center and Prompts",
  },
  {
    body: "Structured is a calm reading view. Session is the live terminal, always the source of truth. Files shows what changed, Claude's edits first, and the whole project tree, where you can open any file and edit it yourself.",
    icon: LayoutPanelLeft,
    id: "view-tabs",
    side: "bottom",
    target: "view-tabs",
    title: "Three ways to follow a session",
  },
  {
    body: "Write to Claude here. Paste images, type / for commands and @ for files. What you send goes straight to the terminal.",
    icon: MessageSquareText,
    id: "composer",
    side: "top",
    target: "composer",
    title: "The composer",
  },
  {
    body: "Open shells in the project folder below the session, for builds, tests and git. The count pulses while something runs.",
    icon: SquareTerminal,
    id: "terminals",
    side: "bottom",
    target: "terminal-toggle",
    title: "Project terminals",
  },
  {
    body: "What this session is: its status, branch and start time, the files it changed, and what it has cost against your plan limits.",
    icon: PanelRight,
    id: "details",
    inspectorTab: "details",
    side: "left",
    target: "inspector",
    title: "Details",
  },
  {
    body: "Every step Claude took in this session, as it happens: each file read, command run and edit. Open a step to see exactly what it did.",
    icon: ListChecks,
    id: "activity",
    inspectorTab: "activity",
    side: "left",
    target: "inspector",
    title: "Activity",
  },
  {
    body: "Your own todos, ideas and notes, kept per project and never sent to Claude. ⌘⇧N adds one from anywhere.",
    icon: NotebookPen,
    id: "notes",
    inspectorTab: "notes",
    keys: ["⌘⇧N"],
    side: "left",
    target: "inspector",
    title: "Notes",
  },
  {
    body: "Jump to any session or run any action from one box.",
    icon: Command,
    id: "palette",
    keys: ["⌘K"],
    side: "right",
    target: "palette",
    title: "The command palette",
  },
  {
    body: "Hide the sidebar and panels when you only want the conversation. The rail on the left brings them back.",
    icon: Maximize2,
    id: "focus",
    side: "right",
    target: "focus-mode",
    title: "Focus mode",
  },
  {
    body: "Themes, notifications, when idle sessions sleep, and more.",
    icon: Settings,
    id: "settings",
    keys: ["⌘,"],
    side: "right",
    target: "settings",
    title: "Make it yours",
  },
  {
    body: "Take this tour again any time from Help → Kriyon Tour, the command palette or Settings.",
    icon: Sparkles,
    id: "done",
    title: "You are all set",
  },
];
