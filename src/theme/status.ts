import type { SessionStatus } from "../types.ts";
import { tokens } from "./tokens.ts";

export interface StatusMeta {
  /** The dot's fill. */
  color: string;
  /**
   * The *text* stop, which is not always {@link color}. Amber at `#d29922`
   * reads as a dot but is too dark to set 10.5px type in, and the idle grey
   * is a decorative stop that fails AA — both lift a step for their labels.
   */
  ink: string;
  label: string;
  /** Soft tinted fill for badges/pills. */
  soft: string;
  /** Faint whole-row wash for states that need the user; null elsewhere. */
  wash: string | null;
}

const META: Record<SessionStatus, StatusMeta> = {
  running: {
    color: tokens.color.status.running,
    ink: tokens.color.status.runningInk,
    label: "Running",
    soft: tokens.color.status.runningSoft,
    wash: null,
  },
  waiting: {
    color: tokens.color.status.waiting,
    ink: tokens.color.status.waitingInk,
    label: "Waiting",
    soft: tokens.color.status.waitingSoft,
    wash: tokens.color.status.waitingWash,
  },
  done: {
    color: tokens.color.status.done,
    ink: tokens.color.status.done,
    label: "Done",
    soft: tokens.color.status.doneSoft,
    wash: null,
  },
  idle: {
    color: tokens.color.status.idle,
    ink: tokens.color.ink.muted,
    label: "Idle",
    soft: tokens.color.status.idleSoft,
    wash: null,
  },
  error: {
    color: tokens.color.status.error,
    ink: tokens.color.status.error,
    label: "Error",
    soft: tokens.color.status.errorSoft,
    wash: tokens.color.status.errorWash,
  },
};

export function statusMeta(status: SessionStatus): StatusMeta {
  return META[status] ?? META.idle;
}

/**
 * A status dot. It pulses while running — that is liveness, not decoration,
 * and it is the only motion on an otherwise still screen. It does not glow:
 * the chrome is flat (ADR-0023), and a 5px halo on a 7px dot was the one
 * piece of elevation left in the sidebar.
 */
export function statusDotStyle(status: SessionStatus, size = 7) {
  const meta = statusMeta(status);
  return {
    animation:
      status === "running" ? "kr-pulse 1.6s ease-in-out infinite" : "none",
    background: meta.color,
    borderRadius: "50%",
    flex: "none",
    height: `${size}px`,
    width: `${size}px`,
  } as const;
}

/**
 * The *idle* dot the canvas draws: a hollow 1.5px ring rather than a filled
 * circle, so a dormant session reads as an outline at a glance and a live one
 * as a solid. Same footprint, so rows stay aligned either way.
 */
export function statusRingStyle(size = 7) {
  return {
    border: `1.5px solid ${tokens.color.status.idle}`,
    borderRadius: "50%",
    boxSizing: "border-box",
    flex: "none",
    height: `${size}px`,
    width: `${size}px`,
  } as const;
}
