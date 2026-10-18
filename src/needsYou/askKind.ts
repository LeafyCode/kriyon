import {
  ClipboardCheck,
  KeyRound,
  type LucideIcon,
  MessageCircleQuestion,
} from "lucide-react";
import type { PendingAskKind } from "../types.ts";

/**
 * How one [Pending ask] kind renders across the attention surfaces. The single
 * source for the ask-kind vocabulary: the sidebar's [Needs-you section] reads
 * `Icon`, the [Needs-you rail]/overlay list reads `glyph`, and the tray reads
 * `emoji` + `pill`. One map keyed by kind, so a new ask kind — or a changed
 * icon — is edited in exactly one place instead of three switch statements.
 */
export interface AskKindVisual {
  /** Emoji marker. Mirrors `crates/kriyon-core/src/notification.rs`. */
  emoji: string;
  /** Text glyph for icon-free lists (the rail/overlay). */
  glyph: string;
  /** Lucide icon for surfaces that render a real icon (the sidebar). */
  Icon: LucideIcon;
  /** Human label. */
  label: string;
  /** Compact action word (a label only — a row navigates, never answers). */
  pill: string;
}

export const ASK_KIND_VISUAL: Record<PendingAskKind, AskKindVisual> = {
  question: {
    Icon: MessageCircleQuestion,
    glyph: "?",
    emoji: "💬",
    pill: "APPROVE",
    label: "Question",
  },
  permission: {
    Icon: KeyRound,
    glyph: "⚿",
    emoji: "🔑",
    pill: "ALLOW",
    label: "Permission",
  },
  plan_approval: {
    Icon: ClipboardCheck,
    glyph: "▤",
    emoji: "📋",
    pill: "REVIEW",
    label: "Plan approval",
  },
};
