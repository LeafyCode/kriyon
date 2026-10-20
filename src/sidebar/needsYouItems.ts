import type { UiSession } from "../state/sessions.ts";
import { unseenOutput, type ViewedMarker } from "../state/viewedMarker.ts";
import type { PendingAskKind, SessionActivity } from "../types.ts";

/**
 * What a Needs-you section row is about: an exact question to answer, a plain
 * wait for input, a failure, or a finished run with output not yet reviewed.
 */
export type NeedsYouKind = "question" | "waiting" | "error" | "done";

/** One row of the sidebar's Needs-you section. */
export interface NeedsYouItem {
  /**
   * The exact ask's kind for question rows — a permission or plan approval
   * shares the question treatment but gets its own icon, since it is approved
   * in the terminal rather than answered in the composer. Null otherwise.
   */
  askKind: PendingAskKind | null;
  /** The one-line ask for question rows; null for every other kind. */
  askText: string | null;
  kind: NeedsYouKind;
  sessionId: string;
}

/** Questions outrank failures outrank plain waits outrank finished runs. */
const KIND_ORDER: Record<NeedsYouKind, number> = {
  question: 0,
  error: 1,
  waiting: 2,
  done: 3,
};

/**
 * The Needs-you section membership, pure and store-shaped: every open session
 * blocked on the user (an exact Pending ask upgrades it to a question), every
 * errored one, and every finished one whose output the user has not seen —
 * "seen" asks the {@link ViewedMarker} for the unseen count (the monotonic
 * `appendSeq` delta), NOT the event array's length: the event ring caps at 1000
 * and evicts from the front, so its length stops moving on long sessions while
 * the counter keeps counting.
 *
 * A finish the backend reconstructed by replaying the events file at launch
 * (`statusOrigin` of `"seeded"`) is excluded outright, whatever the unseen
 * count says: the transcript is re-tailed from offset 0 on every launch while
 * `viewed` lives only in memory, so an unguarded count calls every replayed
 * event unseen and every old finished session lands here on boot.
 */
export function needsYouSectionItems(args: {
  activeSessionId: string | null;
  activity: Record<string, SessionActivity>;
  appendSeq: Record<string, number>;
  sessions: Record<string, UiSession>;
  statusOrigin: Record<string, "seeded" | "live">;
  viewed: Record<string, ViewedMarker>;
}): NeedsYouItem[] {
  const items: NeedsYouItem[] = [];
  for (const session of Object.values(args.sessions)) {
    if (session.archivedAt !== null) {
      continue;
    }
    if (session.status === "waiting") {
      const ask = args.activity[session.id]?.pendingAsk ?? null;
      items.push({
        askKind: ask?.kind ?? null,
        askText: ask?.text ?? null,
        kind: ask ? "question" : "waiting",
        sessionId: session.id,
      });
    } else if (session.status === "error") {
      items.push({
        askKind: null,
        askText: null,
        kind: "error",
        sessionId: session.id,
      });
    } else if (
      session.status === "done" &&
      session.id !== args.activeSessionId &&
      unseenOutput({
        appendSeq: args.appendSeq[session.id] ?? 0,
        marker: args.viewed[session.id],
        origin: args.statusOrigin[session.id],
      }) > 0
    ) {
      items.push({
        askKind: null,
        askText: null,
        kind: "done",
        sessionId: session.id,
      });
    }
  }
  return items.sort(
    (a, b) =>
      KIND_ORDER[a.kind] - KIND_ORDER[b.kind] ||
      (args.sessions[a.sessionId]?.createdAt ?? 0) -
        (args.sessions[b.sessionId]?.createdAt ?? 0)
  );
}
