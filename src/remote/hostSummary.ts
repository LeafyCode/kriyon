/**
 * A paired computer as a device's screens show it: the summary Rust makes
 * (`kriyon_remote::device_view::HostSummary`, field for field), and what
 * both apps derive from it. Imports only the desktop's plain types, so the
 * desktop's Other computers view and the phone app (mobile/app) share it.
 */
import type { SessionStatus, StandingState } from "../types.ts";
import type { LinkState } from "./remoteScreen.ts";

/** Who types into a session now, seen from this device. */
export type Typing = "host" | "you" | "other";

/** One session on a paired computer. */
export interface SessionSummary {
  dialogOpen: boolean;
  id: string;
  lastChangeMs: number;
  /** This device may type now: connected, a Controller, holding control. */
  mayType: boolean;
  needsYou: boolean;
  projectId: string;
  standing: StandingState;
  status: SessionStatus;
  title: string;
  /** `null` until the computer says who holds control. */
  typing: Typing | null;
}

/** A project on a paired computer, where a session can be started. */
export interface ProjectSummary {
  id: string;
  name: string;
  /** Every session in it is parked there. */
  parked: boolean;
}

/** A paired computer, as Rust summarizes it. */
export interface HostSummary {
  hostId: string;
  /** The name it said; `null` until it has. */
  hostName: string | null;
  link: LinkState;
  /** This device may start a session there now. */
  mayStart: boolean;
  projects: ProjectSummary[];
  /** The last refusal it sent, by name (`NotInControl`). */
  refused: string | null;
  role: "viewer" | "controller" | null;
  sessions: SessionSummary[];
}

/** One session that needs you, with its computer. */
export interface NeedsYou<Host> {
  host: Host;
  session: SessionSummary;
}

/**
 * Sessions that need you, newest first: only on computers still paired
 * (in `hosts`) and connected, since nothing else can be acted on from here.
 */
export function needsYou<Host extends { hostId: string }>(
  hosts: Host[],
  summaries: Record<string, HostSummary>
): NeedsYou<Host>[] {
  return hosts
    .flatMap((host) => {
      const summary = summaries[host.hostId];
      if (summary?.link !== "connected") {
        return [];
      }
      return summary.sessions
        .filter((session) => session.needsYou)
        .map((session) => ({ host, session }));
    })
    .sort((a, b) => b.session.lastChangeMs - a.session.lastChangeMs);
}

/** A standing's label, in the desktop's words. */
export function standingLabel(standing: StandingState): string {
  switch (standing) {
    case "running":
      return "Running";
    case "awaiting_input":
      return "Awaiting input";
    case "changed":
      return "Changed";
    case "idle":
      return "Idle";
    case "unknown":
      return "Unknown";
    default: {
      // A standing Rust adds is a type error here, until it has its words.
      const added: never = standing;
      return added;
    }
  }
}

/**
 * How many sessions need you (see [`needsYou`]), counted without building
 * or sorting the list.
 */
export function needsYouCount<Host extends { hostId: string }>(
  hosts: Host[],
  summaries: Record<string, HostSummary>
): number {
  let count = 0;
  for (const host of hosts) {
    const summary = summaries[host.hostId];
    if (summary?.link === "connected") {
      count += summary.sessions.filter((session) => session.needsYou).length;
    }
  }
  return count;
}

/** How every Kriyon pairing code begins (Rust's `INVITE_PREFIX`). */
export const PAIRING_CODE_PREFIX = "kriyon-pair:1:";

/** The pairing code in scanned or pasted text, or `null` if there is none. */
export function pairingCodeFrom(text: string): string | null {
  const code = text.trim();
  return code.startsWith(PAIRING_CODE_PREFIX) ? code : null;
}
