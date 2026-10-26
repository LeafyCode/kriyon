import type { IntegrationStatus, RouteReason } from "../ipc/bridge.ts";

/**
 * Plain words for what Kriyon adds to Claude Code, shared by the welcome
 * screen and Settings so the two always say the same thing.
 */

/** Where Kriyon's hooks live, and why — the reason comes from Rust. */
export function hooksHint(reason: RouteReason): string {
  switch (reason) {
    case "plugin":
      return "Loaded as a plugin only in Kriyon's sessions — your Claude Code settings file has none of them.";
    case "orgBlocks":
      return "Your organization blocks per-session plugins, so these are in ~/.claude/settings.json. They do nothing outside Kriyon.";
    case "policyUnknown":
      return "Kriyon couldn't read your organization's policy, so to be safe these are in ~/.claude/settings.json. They do nothing outside Kriyon.";
    case "refused":
      return "Claude Code refused Kriyon's per-session plugin, so these are in ~/.claude/settings.json. They do nothing outside Kriyon.";
    default:
      return "Off: sessions show “Status unavailable” and the activity log stays empty.";
  }
}

/** What the live-usage switch changes in the user's settings. */
export function liveUsageHint(status: IntegrationStatus): string {
  const own = status.originalStatusLine
    ? ` Yours (${status.originalStatusLine}) still shows, and comes back when this is off.`
    : " Your own status line, if you add one, still shows.";
  return `Wraps the status line in ~/.claude/settings.json to read the context window and your plan's 5-hour and weekly limits. The limits are your account's, so every claude run updates them, in Kriyon or not.${own}`;
}

/** Shown when Claude refused Kriyon's plugin at startup. */
export const REFUSED_TOAST =
  "Your organization blocks Kriyon's per-session plugin, so its hooks moved to ~/.claude/settings.json. Restart the session to see its status.";

/** What turning the companion on means, or why it can't be. */
export function companionHint(available: boolean): string {
  if (!available) {
    return "Needs Kriyon's hooks on as a per-session plugin, which your setup doesn't allow.";
  }
  return "Optional mod in Kriyon's sessions (Claude Code 2.1.287+). It sees your prompts, Claude's replies and every tool call, and sends them only to Kriyon on this Mac. It never approves, blocks or changes anything. Gives exact state, the Structured view, and nested sessions: Claude can start a session beside this one, but it starts only when you asked for it in your own words; anything else waits for you to choose it.";
}

/** One short line per addition that is on: what goes when it is removed. */
export function removalLines(status: IntegrationStatus): string[] {
  const { prefs } = status;
  const lines: string[] = [];
  if (prefs.statusHooks) {
    lines.push("Status hooks: session status and the activity log stop");
  }
  if (prefs.liveUsage) {
    lines.push(
      status.originalStatusLine
        ? `Live usage: your status line goes back to “${status.originalStatusLine}”`
        : "Live usage: Kriyon's status line is taken out"
    );
  }
  if (prefs.companion) {
    lines.push("Kriyon Companion: the Structured view turns off");
  }
  return lines;
}
