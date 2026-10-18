import type { SessionSnapshotRow } from "../ipc/bridge.ts";
import { formatDuration } from "../state/needsYou.ts";
import { askGlyph, type TrayGroups, type TrayRow } from "./trayRows.ts";

type BlockedRow = TrayRow & { blockedMs: number };

/** Build a "needs you" row (status waiting and/or an open ask) from a snapshot. */
function needsYouRow(snap: SessionSnapshotRow, nowMs: number): BlockedRow {
  const ask = snap.pendingAsk;
  const glyph = ask ? askGlyph(ask.kind) : null;
  const asked = ask?.askedAt ? Date.parse(ask.askedAt) : Number.NaN;
  const blockedMs = Number.isNaN(asked) ? 0 : Math.max(0, nowMs - asked);
  return {
    ago: blockedMs > 0 ? formatDuration(blockedMs) : "just now",
    askKind: ask?.kind ?? null,
    blockedMs,
    branch: snap.branch,
    line: ask ? `${glyph?.emoji ?? ""} ${ask.text}`.trim() : snap.summary,
    pill: glyph?.pill ?? null,
    sessionId: snap.sessionId,
    status: snap.status,
    title: snap.title,
  };
}

/** Build a "running" row from a snapshot. */
function runningRow(snap: SessionSnapshotRow): TrayRow {
  return {
    ago: "",
    askKind: null,
    branch: snap.branch,
    line: snap.summary,
    pill: null,
    sessionId: snap.sessionId,
    status: snap.status,
    title: snap.title,
  };
}

/**
 * Partition the backend's live session snapshots into the popover's two groups.
 * Pure — everything comes in as arguments. Membership in "needs you" is the
 * backend-stamped `needsYou` flag (`status waiting` OR an open ask, decided once
 * in `kriyon_core::tray_badge::session_needs_you`), so the popover and the
 * menu-bar badge count read the identical rule and can never diverge. "running"
 * = status `running`; everything else (idle / done / error) is omitted.
 *
 * This reads a self-contained backend snapshot, so it never depends on event
 * timing or a pre-seeded frontend store.
 */
export function snapshotGroups(
  snaps: SessionSnapshotRow[],
  nowMs: number
): TrayGroups {
  const needsYou: BlockedRow[] = [];
  const running: TrayRow[] = [];

  for (const snap of snaps) {
    if (snap.needsYou) {
      needsYou.push(needsYouRow(snap, nowMs));
    } else if (snap.status === "running") {
      running.push(runningRow(snap));
    }
  }

  needsYou.sort((a, b) => b.blockedMs - a.blockedMs);
  return {
    needsYou: needsYou.map(({ blockedMs, ...row }) => row),
    running,
  };
}
