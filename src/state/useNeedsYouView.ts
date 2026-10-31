import { useEffect, useState } from "react";
import type { SessionStanding } from "../types.ts";
import {
  buildStandings,
  groupByProject,
  needsYou,
  type ProjectStandings,
  useCommandCenter,
} from "./commandCenter.ts";
import { buildNeedsYouEntries, type NeedsYouEntry } from "./needsYou.ts";
import { parkedProjectIds, useSessions } from "./sessions.ts";

/** How often staleness and blocked durations are recomputed so `unknown` and
 *  elapsed times advance even when no backend event arrives to trigger a render. */
const TICK_MS = 1500;

/** The derived command-center view: every [Session standing], the blocked
 *  subset, those standings grouped by [Project], and the enriched
 *  [Needs-you rail] entries — all folded from one `nowMs`. */
export interface NeedsYouView {
  blocked: SessionStanding[];
  entries: NeedsYouEntry[];
  groups: ProjectStandings[];
  standings: SessionStanding[];
}

/**
 * The one home for the command-center derivation. Subscribes the session and
 * watcher-liveness slices, runs a light staleness ticker, and folds them through
 * `buildStandings → needsYou → buildNeedsYouEntries` in that order with a single
 * `nowMs`. The [Command center] and the [Needs-you overlay] both read this, so
 * the slice list, the ticker, and the call order live in one place and cannot
 * drift between the two surfaces.
 *
 * The high-churn `events`/`activity` subscriptions are paid for by whichever
 * component calls this hook, so a caller that mounts only while visible (the
 * overlay panel) still only subscribes while open.
 */
export function useNeedsYouView(): NeedsYouView {
  const sessions = useSessions((state) => state.sessions);
  const projects = useSessions((state) => state.projects);
  const activity = useSessions((state) => state.activity);
  const events = useSessions((state) => state.events);
  const hooksOff = useSessions((state) => state.hooksOff);
  const lastSeenMs = useCommandCenter((state) => state.lastSeenMs);
  const lastChangeMs = useCommandCenter((state) => state.lastChangeMs);

  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNowMs(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, []);

  const standings = buildStandings(
    sessions,
    parkedProjectIds(projects),
    lastSeenMs,
    lastChangeMs,
    nowMs,
    hooksOff
  );
  const blocked = needsYou(standings);
  const groups = groupByProject(standings, projects);
  const entries = buildNeedsYouEntries({
    activity,
    blocked,
    events,
    nowMs,
    projects,
    sessions,
  });

  return { standings, blocked, groups, entries };
}
