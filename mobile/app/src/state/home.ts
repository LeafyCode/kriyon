/**
 * What Home and the session screens show, worked out from Rust's
 * summaries: each session's kind and its word, the at-a-glance counts, the
 * cards that need you, a computer's own rows and its link line, and the
 * projects a new session can start in. Pure, so the screens only render.
 */
import {
  type HostSummary,
  needsYou,
  type SessionSummary,
} from "../../../../src/remote/hostSummary.ts";

/** What a session needs, most first. */
export type Kind = "asking" | "yourTurn" | "running" | "idle";

/** Which sessions Home shows. */
export type Filter = "all" | "needsYou" | "running";

/** A status pill's colour family; its word is what it says. */
export type Tone = "amber" | "green" | "blue" | "plain";

export function kindOf(session: SessionSummary): Kind {
  // A dialog that isn't asking you (a menu open) isn't a question.
  if (session.dialogOpen && session.needsYou) {
    return "asking";
  }
  if (session.needsYou) {
    return "yourTurn";
  }
  return session.standing === "running" ? "running" : "idle";
}

export interface Glance {
  asking: number;
  idle: number;
  needsYou: number;
  running: number;
  total: number;
  yourTurn: number;
}

/** Sessions on paired, connected computers, by kind. */
export function glance<Host extends { hostId: string }>(
  hosts: Host[],
  states: Record<string, HostSummary>
): Glance {
  const counts: Glance = {
    asking: 0,
    idle: 0,
    needsYou: 0,
    running: 0,
    total: 0,
    yourTurn: 0,
  };
  for (const host of hosts) {
    const summary = states[host.hostId];
    if (summary?.link !== "connected") {
      continue;
    }
    for (const session of summary.sessions) {
      const kind = kindOf(session);
      counts[kind] += 1;
      counts.total += 1;
      if (kind === "asking" || kind === "yourTurn") {
        counts.needsYou += 1;
      }
    }
  }
  return counts;
}

/** The cards under Needs you, newest first: asking or your turn. */
export function needsYouCards<Host extends { hostId: string }>(
  hosts: Host[],
  states: Record<string, HostSummary>
): { host: Host; kind: Kind; session: SessionSummary }[] {
  return needsYou(hosts, states).map(({ host, session }) => ({
    host,
    kind: kindOf(session),
    session,
  }));
}

/** A computer's own rows under `filter`: what needs you is on top instead. */
export function hostRows(
  summary: HostSummary,
  filter: Filter
): { idle: SessionSummary[]; running: SessionSummary[] } {
  if (filter === "needsYou") {
    return { idle: [], running: [] };
  }
  const running = summary.sessions.filter((s) => kindOf(s) === "running");
  const idle =
    filter === "all"
      ? summary.sessions.filter((s) => kindOf(s) === "idle")
      : [];
  return { idle, running };
}

/** How long ago `sinceMs` was, short ("4m"); `null` when it isn't known. */
export function ageText(sinceMs: number, nowMs: number): string | null {
  if (sinceMs <= 0) {
    return null;
  }
  const seconds = Math.max(0, Math.floor((nowMs - sinceMs) / 1000));
  if (seconds < 60) {
    return "now";
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
}

const two = (n: number) => String(n).padStart(2, "0");

/** How long a turn has run, as a clock ("3:12", "1:02:03"). */
export function runningFor(sinceMs: number, nowMs: number): string {
  const seconds = Math.max(0, Math.floor((nowMs - sinceMs) / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  return hours > 0
    ? `${hours}:${two(minutes)}:${two(rest)}`
    : `${minutes}:${two(rest)}`;
}

/** A session's status pill: always a word, never colour alone. */
export function pillFor(
  session: SessionSummary,
  nowMs: number
): { label: string; tone: Tone } {
  const age = ageText(session.lastChangeMs, nowMs);
  const aged = (word: string) =>
    age && age !== "now" ? `${word} · ${age}` : word;
  switch (kindOf(session)) {
    case "asking":
      return { label: aged("Asking"), tone: "amber" };
    case "yourTurn":
      return { label: aged("Your turn"), tone: "green" };
    case "running":
      return {
        label: session.runningSinceMs
          ? `Running ${runningFor(session.runningSinceMs, nowMs)}`
          : "Running",
        tone: "blue",
      };
    default:
      // Not known (the computer's hooks are off) is never said as Idle.
      return {
        label: session.standing === "unknown" ? "Unknown" : "Idle",
        tone: "plain",
      };
  }
}

const ROLE_WORDS = { controller: "Controller", viewer: "Viewer" } as const;

/** This device's role on a computer, in a word; `null` while not known. */
export function roleWord(role: "controller" | "viewer" | null): string | null {
  return role ? ROLE_WORDS[role] : null;
}

/** A computer's line under its name: its link, path and this phone's role. */
export function linkWords(
  summary: HostSummary | undefined,
  nowMs: number
): string {
  if (!summary) {
    return "Connecting…";
  }
  const role = roleWord(summary.role);
  const parts: string[] = [];
  switch (summary.link) {
    case "connected":
      parts.push("Connected");
      if (summary.path === "direct") {
        parts.push("direct");
      } else if (summary.path === "relay") {
        parts.push("through the relay");
      }
      break;
    case "lost": {
      parts.push("Reconnecting");
      const seen = summary.lastSeenMs
        ? ageText(summary.lastSeenMs, nowMs)
        : null;
      if (seen) {
        parts.push(
          seen === "now" ? "last seen just now" : `last seen ${seen} ago`
        );
      }
      break;
    }
    case "removed":
      return "Removed from that computer · pair again to use it";
    default:
      return "Connecting…";
  }
  if (role) {
    parts.push(role);
  }
  return parts.join(" · ");
}

/** The projects a new session can start in, with how full each is. */
export function projectChoices(
  summary: HostSummary
): { id: string; name: string; note: string; parked: boolean }[] {
  return summary.projects.map((project) => {
    const open = summary.sessions.filter(
      (s) => s.projectId === project.id
    ).length;
    let note: string;
    if (project.parked) {
      note = "Parked";
    } else if (open === 0) {
      note = "No open sessions";
    } else {
      note = open === 1 ? "1 open session" : `${open} open sessions`;
    }
    return { id: project.id, name: project.name, note, parked: project.parked };
  });
}

/** This phone's key as people compare it: twelve hex digits, in fours. */
export function shortKey(deviceId: string | null): string {
  if (!deviceId) {
    return "";
  }
  return (deviceId.slice(0, 12).match(/.{1,4}/g) ?? []).join("·");
}
