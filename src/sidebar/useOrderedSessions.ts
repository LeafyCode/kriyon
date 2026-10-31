import { useCommandCenter } from "../state/commandCenter.ts";
import {
  effectiveSessionSort,
  type SessionSort,
  type SidebarMode,
  useLayout,
} from "../state/layout.ts";
import { useSessions } from "../state/sessions.ts";
import type { ProjectRow } from "../types.ts";
import {
  EMPTY_ORDER,
  type MatchedSessions,
  type OrderInputs,
  orderMatched,
} from "./sessionOrder.ts";

/** The session-store slices the ordering cache reads, in one place. */
function orderInputs(
  state: ReturnType<typeof useSessions.getState>
): OrderInputs {
  return {
    appendSeq: state.appendSeq,
    sessions: state.sessions,
    statusOrigin: state.statusOrigin,
    viewed: state.viewed,
  };
}

interface OrderedSessionsOptions {
  /** A dormant group (in the "N inactive projects" fold) turns the staleness
   *  threshold off: every one of its sessions is stale by definition. */
  dormant?: boolean;
  /** The rail's search text, lower-cased; "" when not searching. */
  filter?: string;
  nowMinute: number;
  /** Draw the project's parked sessions (the Parked section) instead of the
   *  ones on the rail. */
  parked?: boolean;
}

/**
 * A project's sessions as the sidebar draws them — ordered, folded ("N done",
 * "N older") and nested — wired to every layout setting that shapes them. The
 * one place those settings are read, so the rail group and the Parked list
 * can't disagree: a sort or fold setting added here reaches both.
 */
export function useOrderedSessions(
  project: ProjectRow,
  {
    dormant = false,
    filter = "",
    nowMinute,
    parked = false,
  }: OrderedSessionsOptions
): MatchedSessions & {
  filtering: boolean;
  mode: SidebarMode;
  sort: SessionSort;
} {
  // A query matching the project name keeps the whole group; otherwise it
  // narrows to sessions whose title matches.
  const nameMatch =
    filter !== "" && project.name.toLowerCase().includes(filter);
  const filtering = filter !== "";
  const mode = useLayout((state) => state.layout.sidebarMode);
  // A filtered rail shows every match as a row (no Done fold), so its ordering
  // stays `calm` even in triage — otherwise a searched-for finished session
  // would hide inside the summary.
  const listMode: SidebarMode = filtering ? "calm" : mode;
  const sort = useLayout((state) =>
    effectiveSessionSort(state.layout, project.id)
  );
  const manual = useLayout(
    (state) => state.layout.manualSessionOrder[project.id] ?? EMPTY_ORDER
  );
  const hideOlderThan = useLayout((state) => state.layout.hideOlderThan);
  const lastChangeMs = useCommandCenter((state) => state.lastChangeMs);
  // Filtering shows every match (no fold), same guard as drag. A dormant
  // group turns the threshold off too: its sessions are all stale by
  // definition (that is what put it in the fold), so keeping the threshold on
  // would hide every one of them behind a second "N older" fold inside the
  // fold the user just opened.
  const threshold = filtering || dormant ? "off" : hideOlderThan;
  // One subscription for the whole ordering result: orderMatched's memo cache
  // returns the same identity while its inputs are unchanged, so plain
  // equality suffices — no useShallow.
  const ordered = useSessions((state) =>
    orderMatched(
      orderInputs(state),
      project,
      filter,
      nameMatch,
      listMode,
      sort,
      manual,
      {
        activeSessionId: state.activeSessionId,
        lastChangeMs,
        now: nowMinute,
        threshold,
      },
      parked
    )
  );
  return { ...ordered, filtering, mode, sort };
}
