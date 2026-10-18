import {
  type CSSProperties,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { listPastSessions } from "../ipc/bridge.ts";
import { resumePastSession } from "../state/actions.ts";
import { useSessions } from "../state/sessions.ts";
import { createSwrResource } from "../state/swrResource.ts";
import { sectionLabel } from "../theme/recipes.ts";
import { tokens } from "../theme/tokens.ts";
import type { PastSession, PastSessionPage } from "../types.ts";
import {
  BUCKET_ORDER,
  dateBucket,
  relativeTime,
  shortTime,
} from "./pastSessionTime.ts";

/** Silently swallow a floating promise (errors are already caught inside fetchPage). */
function ignore(promise: Promise<unknown>): void {
  promise.catch(() => {
    // Discovery errors are handled inside fetchPage; nothing to do here.
  });
}

/** How many past sessions to load per page — "a few first, then Show more". */
const INITIAL_LIMIT = 15;
const PAGE_STEP = 30;

const EMPTY_PAGE: PastSessionPage = { items: [], total: 0 };

/**
 * Keyed [SWR resource] over discovered History pages, alive for the app's
 * lifetime. Discovery reads and parses whole transcripts, so it can take
 * seconds on a busy project — a re-expanded History paints the last known page
 * instantly (via `peek`) while a background revalidation replaces it, and a
 * failed refetch keeps serving the stale page.
 */
const pastSessionsResource = createSwrResource<PastSessionPage>();

/** Test seam: drop every cached history page. */
export function clearPastSessionsCache(): void {
  pastSessionsResource.clear();
}

const rowStyle: CSSProperties = {
  alignItems: "baseline",
  background: "transparent",
  border: "none",
  borderRadius: tokens.radius.sm,
  color: tokens.color.ink.secondary,
  cursor: "pointer",
  display: "flex",
  fontFamily: tokens.font.sans,
  gap: "8px",
  // Allow the row to shrink below its content's intrinsic width so the title
  // can ellipsize instead of forcing the rail wider.
  minWidth: 0,
  overflow: "hidden",
  padding: "4px 8px",
  textAlign: "left",
  width: "100%",
};

const bucketHeaderStyle: CSSProperties = {
  ...sectionLabel(),
  padding: "10px 8px 2px",
};

const titleStyle: CSSProperties = {
  flex: "1 1 auto",
  fontSize: "12.5px",
  minWidth: 0,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

/** The compact right-column timestamp — the bucket carries the coarse date. */
const timeStyle: CSSProperties = {
  color: tokens.color.ink.muted,
  flex: "none",
  fontFamily: tokens.font.mono,
  fontSize: "10px",
};

const hintStyle: CSSProperties = {
  color: tokens.color.ink.muted,
  fontSize: "10.5px",
  padding: "4px 8px",
};

/** First-load placeholder bars; widths staggered so they read as text lines. */
const SKELETON_WIDTHS = ["72%", "55%", "64%"] as const;

function skeletonRowStyle(width: string): CSSProperties {
  return {
    animation: "kr-pulse 1.4s ease-in-out infinite",
    background: tokens.color.surface.s2,
    borderRadius: tokens.radius.sm,
    height: "10px",
    margin: "7px 8px",
    width,
  };
}

const showMoreStyle: CSSProperties = {
  alignItems: "center",
  background: "transparent",
  border: "none",
  borderRadius: tokens.radius.sm,
  color: tokens.color.ink.muted,
  cursor: "pointer",
  display: "flex",
  fontFamily: tokens.font.sans,
  fontSize: "11px",
  gap: "6px",
  padding: "5px 8px",
  textAlign: "left",
  width: "100%",
};

/** Title to show for a past session, with graceful fallbacks. */
function rowLabel(past: PastSession): string {
  if (past.title) {
    return past.title;
  }
  if (past.preview) {
    return past.preview;
  }
  const base = past.cwd?.split("/").filter(Boolean).pop() ?? "session";
  return `${base} — ${new Date(past.lastActiveMs).toLocaleDateString()}`;
}

/** The hover tooltip: full title, spelled-out recency, and the git branch. */
function rowTooltip(past: PastSession, now: number): string {
  const parts = [rowLabel(past), relativeTime(past.lastActiveMs, now)];
  if (past.gitBranch) {
    parts.push(`on ${past.gitBranch}`);
  }
  return parts.join(" · ");
}

/**
 * A project's on-disk past sessions.
 *
 * Controlled: the disclosure lives on the project group's single
 * "N older · history" row, which folds the stale open sessions and this list
 * behind one control instead of the two stacked utility rows every group used
 * to carry. This component owns only the list and its lazy, cached loading.
 */
export function EarlierSessions({
  open,
  projectId,
  projectPath,
}: {
  /** Rendered (and fetched) only while the group's older·history row is open. */
  open: boolean;
  projectId: string;
  projectPath: string;
}) {
  const [limit, setLimit] = useState(INITIAL_LIMIT);
  const [page, setPage] = useState<PastSessionPage>(
    () => pastSessionsResource.peek(projectPath) ?? EMPTY_PAGE
  );
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);

  // Claude session ids Kriyon already tracks for this project — used to hide
  // past sessions that are already live or persisted.
  const sessions = useSessions((state) => state.sessions);
  const trackedIds = useMemo(() => {
    const ids = new Set<string>();
    for (const session of Object.values(sessions)) {
      if (session.projectId === projectId && session.claudeSessionId) {
        ids.add(session.claudeSessionId);
      }
    }
    return ids;
  }, [sessions, projectId]);

  const fetchPage = useCallback(
    (nextLimit: number) =>
      pastSessionsResource.revalidate(
        projectPath,
        () => listPastSessions(projectPath, nextLimit),
        {
          onStart: () => {
            setLoading(true);
            setFailed(false);
          },
          // On success the fresh page paints; on failure the stale page is
          // served (kept in view), and only a cold failure — nothing cached —
          // is admitted instead of a truthful "No earlier sessions".
          onSettle: (outcome) => {
            setPage(outcome.value ?? EMPTY_PAGE);
            setFailed(outcome.coldFailure);
          },
          onDone: () => setLoading(false),
        }
      ),
    [projectPath]
  );

  // `loading` as a ref so the open-effect can consult it without listing it as
  // a dependency — depending on the flag it sets would re-run the effect the
  // moment a fetch starts.
  const loadingRef = useRef(loading);
  loadingRef.current = loading;
  const limitRef = useRef(limit);
  limitRef.current = limit;

  // Revalidate on open: the cached page (if any) paints now, the fresh page
  // replaces it when the scan lands. A scan already in flight is enough —
  // re-opening must not stack another full-disk pass.
  useEffect(() => {
    if (open && !loadingRef.current) {
      ignore(fetchPage(limitRef.current));
    }
  }, [open, fetchPage]);

  const onShowMore = useCallback(() => {
    const next = limit + PAGE_STEP;
    setLimit(next);
    ignore(fetchPage(next));
  }, [fetchPage, limit]);

  const visible = page.items.filter(
    (item) => !trackedIds.has(item.claudeSessionId)
  );

  // Group the (already newest-first) rows into recency buckets, à la Claude
  // Desktop. Computed once per render against a single `now` so every row in a
  // group is bucketed against the same instant.
  const now = Date.now();
  const groups = BUCKET_ORDER.map((bucket) => ({
    bucket,
    items: visible.filter(
      (item) => dateBucket(item.lastActiveMs, now) === bucket
    ),
  })).filter((group) => group.items.length > 0);

  const renderRow = (item: PastSession) => (
    <button
      className="kr-hover-surface"
      key={item.claudeSessionId}
      onClick={() => resumePastSession(item)}
      style={rowStyle}
      title={rowTooltip(item, now)}
      type="button"
    >
      <span style={titleStyle}>{rowLabel(item)}</span>
      <span data-testid="history-time" style={timeStyle}>
        {shortTime(item.lastActiveMs, now)}
      </span>
    </button>
  );

  return (
    <div data-testid="earlier-sessions">
      {open ? (
        <div
          className="kr-disclose"
          data-testid="history-list"
          style={{ display: "flex", flexDirection: "column", gap: "1px" }}
        >
          {groups.map((group) => (
            <div key={group.bucket}>
              <div style={bucketHeaderStyle}>{group.bucket}</div>
              {group.items.map(renderRow)}
            </div>
          ))}
          {loading && page.items.length === 0
            ? SKELETON_WIDTHS.map((width) => (
                <div
                  data-testid="history-skeleton-row"
                  key={width}
                  style={skeletonRowStyle(width)}
                />
              ))
            : null}
          {!loading && failed && page.items.length === 0 ? (
            <span style={hintStyle}>Couldn't load history</span>
          ) : null}
          {!(loading || failed) &&
          visible.length === 0 &&
          page.items.length >= page.total ? (
            <span style={hintStyle}>No earlier sessions</span>
          ) : null}
          {!loading && page.items.length < page.total ? (
            <button
              aria-label="Show more"
              className="kr-hover-surface"
              onClick={onShowMore}
              style={showMoreStyle}
              type="button"
            >
              Show more…
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
