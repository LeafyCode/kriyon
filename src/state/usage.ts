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
  /** The [Limit pace] warning: a window on course to run out before it
   *  resets, at the rate of the last hour. */
  pace: { text: string; tone: "high" } | null;
  windows: LimitReading[];
}

/** One reading of a window's use, when it was seen. */
export interface LimitSample {
  atMs: number;
  usedPercentage: number;
}

/** Readings of each window since it last reset, oldest first. */
export interface LimitSamples {
  fiveHour: LimitSample[];
  sevenDay: LimitSample[];
}

/** The rate is read over this much of the recent past. */
const PACE_LOOKBACK_MS = 60 * 60_000;
/** Too short a span, or too small a rise, says nothing about a rate. */
const PACE_MIN_SPAN_MS = 10 * 60_000;
const PACE_MIN_RISE = 1;

/**
 * [Limit pace]: when a window runs out if use keeps rising as it has over the
 * last hour, or `null` when it would reset first or the readings are too few
 * to say. Measured from the hour's first reading to `now` at the window's
 * current figure — an hour that went quiet slows the rate, as it should.
 * Derived only from Claude's own figures (ADR-0050); never a count of tokens.
 */
export function limitPace(
  samples: readonly LimitSample[],
  window: LimitWindow,
  nowMs: number
): { runsOutInMs: number } | null {
  // A window at 100% has run out: the limit alert says so, not a forecast.
  if (window.usedPercentage >= 100) {
    return null;
  }
  const first = samples.find((s) => s.atMs >= nowMs - PACE_LOOKBACK_MS);
  if (!first) {
    return null;
  }
  const span = nowMs - first.atMs;
  const rise = window.usedPercentage - first.usedPercentage;
  if (span < PACE_MIN_SPAN_MS || rise < PACE_MIN_RISE) {
    return null;
  }
  const left = Math.max(0, 100 - window.usedPercentage);
  const runsOutInMs = Math.round((left / rise) * span);
  return nowMs + runsOutInMs < window.resetsAt * 1000 ? { runsOutInMs } : null;
}

/** "about 2h", "about 40m". */
function aboutDuration(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  return minutes < 90
    ? `about ${minutes}m`
    : `about ${Math.round(minutes / 60)}h`;
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
  nowMs: number,
  samples: LimitSamples = { fiveHour: [], sevenDay: [] }
): PlanLimitsView {
  const windows: LimitReading[] = [];
  let pace: PlanLimitsView["pace"] = null;
  let soonest = Number.POSITIVE_INFINITY;
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
      const projected = limitPace(samples[sampleKey(id)], window, nowMs);
      if (projected && projected.runsOutInMs < soonest) {
        soonest = projected.runsOutInMs;
        pace = {
          text: `${label} runs out in ${aboutDuration(projected.runsOutInMs)} at this rate`,
          tone: "high",
        };
      }
    }
  }
  return { alert: limitsAlert(windows), pace, windows };
}

function sampleKey(id: LimitReading["id"]): keyof LimitSamples {
  return id === "five-hour" ? "fiveHour" : "sevenDay";
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
