import { contextLine } from "../sidebar/sessionContext.ts";
import type {
  PendingAskKind,
  ProjectRow,
  SessionActivity,
  SessionStanding,
  StudioEvent,
} from "../types.ts";
import type { UiSession } from "./sessions.ts";

/** Cap for the best-effort snippet drawn from the last assistant message. */
const SNIPPET_MAX = 120;

/**
 * The ask an entry renders: the exact Pending ask when the backend knows one,
 * else a best-effort snippet of the last assistant message. The tier is shown
 * honestly — exact asks get their kind's icon, snippets render quieter.
 */
export type EntryAsk =
  | { kind: PendingAskKind; text: string; tier: "exact" }
  | { kind: "snippet"; text: string; tier: "best_effort" };

/** One session's row in the Needs-you list (rail and overlay). */
export interface NeedsYouEntry {
  ask: EntryAsk | null;
  blockedForMs: number;
  contextText: string | null;
  projectName: string;
  sessionId: string;
  title: string;
}

/** First line of the last assistant message, truncated — the snippet fallback. */
export function snippetFromEvents(
  events: StudioEvent[] | undefined
): string | null {
  if (!events) {
    return null;
  }
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (event?.kind === "assistant") {
      const line = event.text
        .split("\n")
        .map((l) => l.trim())
        .find((l) => l.length > 0);
      if (!line) {
        return null;
      }
      return line.length > SNIPPET_MAX
        ? `${line.slice(0, SNIPPET_MAX)}…`
        : line;
    }
  }
  return null;
}

/** "blocked 12m" durations: <1m, Nm, then Nh MMm. */
export function formatDuration(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) {
    return "<1m";
  }
  if (minutes < 60) {
    return `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return `${hours}h ${String(rest).padStart(2, "0")}m`;
}

function blockedFor(
  askedAt: string | null | undefined,
  lastChangeMs: number,
  nowMs: number
): number {
  const asked = askedAt ? Date.parse(askedAt) : Number.NaN;
  const since = Number.isNaN(asked) ? lastChangeMs : asked;
  return Math.max(0, nowMs - since);
}

/**
 * Enrich the blocked standings into renderable entries, longest-blocked first.
 * Pure: everything comes in as arguments, nothing is stored.
 */
export function buildNeedsYouEntries(args: {
  activity: Record<string, SessionActivity>;
  blocked: SessionStanding[];
  events: Record<string, StudioEvent[]>;
  nowMs: number;
  projects: ProjectRow[];
  sessions: Record<string, UiSession>;
}): NeedsYouEntry[] {
  const entries = args.blocked.map((standing) => {
    const session = args.sessions[standing.sessionId];
    const activity = args.activity[standing.sessionId];
    const pending = activity?.pendingAsk ?? null;
    const snippet = pending
      ? null
      : snippetFromEvents(args.events[standing.sessionId]);
    let ask: EntryAsk | null = null;
    if (pending) {
      ask = { kind: pending.kind, text: pending.text, tier: "exact" };
    } else if (snippet) {
      ask = { kind: "snippet", text: snippet, tier: "best_effort" };
    }
    const context = session
      ? contextLine(session.status, session.summary, activity)
      : null;
    return {
      ask,
      blockedForMs: blockedFor(
        pending?.askedAt,
        standing.lastChangeMs,
        args.nowMs
      ),
      contextText: context?.text ?? null,
      projectName:
        args.projects.find((p) => p.id === standing.projectId)?.name ??
        standing.projectId,
      sessionId: standing.sessionId,
      title: session?.title ?? standing.sessionId,
    };
  });
  return entries.sort((a, b) => b.blockedForMs - a.blockedForMs);
}
