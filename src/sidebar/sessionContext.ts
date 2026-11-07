import { toolLabel } from "../inspector/activity/toolLabel.ts";
import type {
  HooksOffScope,
  SessionActivity,
  SessionStatus,
} from "../types.ts";

/** How a session row's context line should be inked. */
export type ContextTone = "waiting" | "error" | "live" | "muted";

export interface ContextLine {
  text: string;
  tone: ContextTone;
}

/** Why a session's hooks can't run: where the setting is, or what is missing. */
const HOOKS_OFF_WHY: Record<HooksOffScope, string> = {
  kriyon: "hooks off in Kriyon settings",
  local: "hooks off in .claude/settings.local.json",
  managed: "hooks off by managed settings",
  project: "hooks off in .claude/settings.json",
  python: "hooks need Python, which isn't installed",
  user: "hooks off in ~/.claude/settings.json",
};

function agentPhrase(count: number): string {
  return count === 1 ? "1 agent" : `${count} agents`;
}

/**
 * The one line under a session's title, chosen by what the user most needs to
 * know: a status that can't be known (hooks off) first, then blocked states,
 * then live work (the in-flight tool and running
 * subagents), then the last status summary as a fallback.
 */
export function contextLine(
  status: SessionStatus,
  summary: string,
  activity: SessionActivity | undefined,
  hooksOff?: HooksOffScope
): ContextLine | null {
  if (hooksOff) {
    // No hook can ever fire, so the status is a guess: say why instead.
    return {
      text: `Status unavailable · ${HOOKS_OFF_WHY[hooksOff]}`,
      tone: "muted",
    };
  }
  if (status === "waiting") {
    // The structured [Pending ask] is the source of truth — the Needs-you
    // section reads the same field. A generic permission gate on the
    // `AskUserQuestion` tool can pollute the flat `summary` to "Needs
    // permission" even when the real ask is a question, so prefer the ask.
    const askText = activity?.pendingAsk?.text;
    return { text: askText || summary || "Needs your input", tone: "waiting" };
  }
  if (status === "error") {
    return { text: summary || "Error", tone: "error" };
  }
  const agents =
    activity?.subagents.filter((a) => a.state === "running").length ?? 0;
  const tool = activity?.main.currentTool;
  if (tool) {
    const base = toolLabel(tool);
    return {
      text: agents > 0 ? `${base} · ${agentPhrase(agents)}` : base,
      tone: "live",
    };
  }
  if (agents > 0) {
    return { text: `${agentPhrase(agents)} running`, tone: "live" };
  }
  return summary ? { text: summary, tone: "muted" } : null;
}
