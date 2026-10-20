/**
 * The sidebar row's [Session footprint] chip: label + severity tone for one
 * session's latest reading. Pure, so the thresholds stay unit-testable.
 */

/**
 * Share of the whole-app [Memory budget] at which one session's chip turns
 * amber ("getting big"), then red ("this is the problem").
 *
 * Fractions of the user's own ceiling rather than fixed byte counts: the chip
 * and the over-budget warning have to agree about what "a lot" means, and a
 * user who sets a 2 GB budget should see a 700 MB session flagged instead of
 * styled against a constant that ignores their setting.
 */
const ELEVATED_SHARE = 1 / 6;
const HIGH_SHARE = 1 / 3;

export type MemoryTone = "quiet" | "elevated" | "high";

export interface MemoryChipView {
  label: string;
  tone: MemoryTone;
}

/** Human MB/GB label: whole MB below 1 GB, one decimal above. */
export function formatMb(mb: number): string {
  if (mb >= 1024) {
    return `${(mb / 1024).toFixed(1)} GB`;
  }
  return `${Math.round(mb)} MB`;
}

/**
 * CPU percent of one core (so above 100 when several cores are busy, as in
 * Activity Monitor): one decimal below 10, whole numbers above. A dash until
 * the backend has two samples to diff.
 */
export function formatCpu(pct: number | null | undefined): string {
  if (pct === undefined || pct === null) {
    return "—";
  }
  const rounded = Math.round(pct * 10) / 10;
  if (rounded < 10) {
    return `${rounded}%`;
  }
  return `${Math.round(pct)}%`;
}

/**
 * The chip for one session's reading against the user's [Memory budget], or
 * `null` when there is nothing worth rendering (no sample yet, or a zero
 * reading from a dead tree).
 */
export function memoryChipView(
  mb: number | undefined,
  budgetMb: number
): MemoryChipView | null {
  if (mb === undefined || mb <= 0) {
    return null;
  }
  const label = formatMb(mb);
  // A missing or nonsensical budget cannot silently produce NaN comparisons;
  // treat any reading against it as worth looking at.
  if (budgetMb <= 0) {
    return { label, tone: "high" };
  }
  const share = mb / budgetMb;
  if (share >= HIGH_SHARE) {
    return { label, tone: "high" };
  }
  return { label, tone: share >= ELEVATED_SHARE ? "elevated" : "quiet" };
}
