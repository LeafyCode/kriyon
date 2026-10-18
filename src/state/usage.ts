import type { LimitWindow, PlanLimits, UsageSnapshot } from "../types.ts";

/**
 * Compact token count: 920 → "920", 4_100 → "4.1k", 48_200 → "48.2k",
 * 2_340_000 → "2.34M".
 */
export function formatTokens(n: number): string {
  if (n < 1000) {
    return String(n);
  }
  const k = n / 1000;
  // Decide on the rounded figure, so 999,600 reads "1.00M", not "1000k".
  if (Math.round(k) >= 1000) {
    return `${(n / 1_000_000).toFixed(2)}M`;
  }
  return `${k >= 100 ? Math.round(k) : k.toFixed(1)}k`;
}

/**
 * When a [Plan limits] window resets, as a clock time the way Claude shows it,
 * in the user's own locale and clock: "2:40 PM" later today, "Mon 5:30 AM" on
 * another day.
 */
export function formatResetAt(resetsAtSecs: number, nowMs: number): string {
  const at = new Date(resetsAtSecs * 1000);
  const time = at.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
  if (at.toDateString() === new Date(nowMs).toDateString()) {
    return time;
  }
  return `${at.toLocaleDateString(undefined, { weekday: "short" })} ${time}`;
}

/**
 * The [Session usage view]: the single resolved answer for a session's context
 * window that every surface reads, taken only from Claude's own status-line
 * reading — without one there is no figure, never an estimate. The composer
 * and the inspector both read this, so they can never disagree.
 */
export interface SessionUsageView {
  /** Tokens in the context window now, from Claude's last reply. */
  contextTokens: number | null;
  /** Percent of the context window in use (0-100), from Claude's reading. */
  ctxPct: number | null;
  /** Compact "60.8k · 6% ctx", or "" without Claude's reading. */
  label: string;
  /** "60.8k · 6%", or "—" without Claude's reading. */
  reading: string;
}

export function sessionUsageView(
  live: UsageSnapshot | undefined
): SessionUsageView {
  const pct = live?.usedPercentage;
  const ctxPct =
    pct === null || pct === undefined
      ? null
      : Math.min(100, Math.max(0, Math.round(pct)));
  const contextTokens = live?.inputTokens ?? null;
  if (ctxPct === null) {
    return { contextTokens, ctxPct, label: "", reading: "—" };
  }
  const reading =
    contextTokens === null
      ? `${ctxPct}%`
      : `${formatTokens(contextTokens)} · ${ctxPct}%`;
  return { contextTokens, ctxPct, label: `${reading} ctx`, reading };
}

/** How full a usage figure reads: `high` from 80%, `full` once it reads 100%. */
export type UsageTone = "normal" | "high" | "full";

const HIGH_PCT = 80;
const FULL_PCT = 100;

export function usageTone(percent: number | null): UsageTone {
  if (percent === null) {
    return "normal";
  }
  const shown = Math.round(percent);
  if (shown >= FULL_PCT) {
    return "full";
  }
  return shown >= HIGH_PCT ? "high" : "normal";
}

/** Where a [Plan limits] figure comes from, and why it can trail Claude's own
 *  `/usage` pane. */
export const LIMIT_NOTE =
  "As Claude's status line reports it, from the last reply in any claude session. /usage may read 1% higher.";

/** One [Plan limits] window, ready to show. */
export interface LimitReading {
  id: "five-hour" | "seven-day";
  label: string;
  /** Rounded, 0-100. */
  percent: number;
  /** When it resets, as Claude shows it: "2:40 PM", "Mon 5:30 AM". */
  resets: string;
  tone: UsageTone;
}

/**
 * The [Plan limits view]: the account's limits as every surface shows them —
 * each reported window in a fixed order, and the one warning worth raising
 * (the window closest to running out, once it is at 80% or more). The
 * Inspector and the [Usage card] both read this, so they can never word or
 * colour the same limit differently.
 */
export interface PlanLimitsView {
  alert: { text: string; tone: Exclude<UsageTone, "normal"> } | null;
  windows: LimitReading[];
}

const WINDOWS: {
  id: LimitReading["id"];
  label: string;
  pick: (limits: PlanLimits) => LimitWindow | null;
}[] = [
  { id: "five-hour", label: "5-hour limit", pick: (l) => l.fiveHour },
  { id: "seven-day", label: "Weekly limit", pick: (l) => l.sevenDay },
];

export function planLimitsView(
  limits: PlanLimits,
  nowMs: number
): PlanLimitsView {
  const windows: LimitReading[] = [];
  for (const { id, label, pick } of WINDOWS) {
    const window = pick(limits);
    if (window !== null) {
      windows.push({
        id,
        label,
        percent: Math.round(window.usedPercentage),
        resets: formatResetAt(window.resetsAt, nowMs),
        tone: usageTone(window.usedPercentage),
      });
    }
  }
  return { alert: limitsAlert(windows), windows };
}

function limitsAlert(windows: LimitReading[]): PlanLimitsView["alert"] {
  const worst = windows.reduce<LimitReading | null>(
    (most, w) => (most === null || w.percent > most.percent ? w : most),
    null
  );
  if (worst === null || worst.tone === "normal") {
    return null;
  }
  return worst.tone === "full"
    ? { text: `${worst.label} reached`, tone: "full" }
    : { text: `${worst.label} at ${worst.percent}%`, tone: "high" };
}
