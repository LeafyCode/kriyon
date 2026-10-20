import { ASK_KIND_VISUAL } from "../needsYou/askKind.ts";
import type { PendingAskKind, SessionStatus } from "../types.ts";

/** Emoji + short pill label per ask kind, from the shared ask-kind vocabulary. */
export function askGlyph(kind: PendingAskKind): {
  emoji: string;
  pill: string;
} {
  const { emoji, pill } = ASK_KIND_VISUAL[kind];
  return { emoji, pill };
}

/** One rendered row in the popover. */
export interface TrayRow {
  ago: string;
  askKind: PendingAskKind | null;
  branch: string | null;
  line: string;
  pill: string | null;
  sessionId: string;
  status: SessionStatus;
  title: string;
}

export interface TrayGroups {
  needsYou: TrayRow[];
  running: TrayRow[];
}
