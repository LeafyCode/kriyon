import type { CompanionStatus } from "../ipc/bridge.ts";

/** What the session header's companion chip says; `null` hides it. */
export interface CompanionChipView {
  label: string;
  /** Lit when the companion is talking to Kriyon. */
  on: boolean;
  title: string;
}

/** The chip for one session's [Companion state]. */
export function companionChip(
  status: CompanionStatus
): CompanionChipView | null {
  switch (status.state) {
    case "on":
      return {
        label: "Companion",
        on: true,
        title: `Kriyon Companion is on${
          status.claudeVersion ? ` (Claude Code ${status.claudeVersion})` : ""
        }.`,
      };
    case "starting":
      return {
        label: "Companion…",
        on: false,
        title:
          "Waiting for Claude Code to start — or for you to trust this folder, since no plugin loads before that.",
      };
    case "silent":
      return {
        label: "Companion off",
        on: false,
        title:
          "Not active in this session: Claude Code may be older than 2.1.287, or mods are turned off here. Everything else works from hooks.",
      };
    case "blocked":
      return {
        label: "Companion blocked",
        on: false,
        title:
          "Your organization allows only its own mods, so the companion can't load. Everything else works from hooks.",
      };
    case "needsRestart":
      return {
        label: "Restart for Companion",
        on: false,
        title:
          "This session started before the companion was turned on. Restart it to load the companion.",
      };
    default:
      return null;
  }
}
