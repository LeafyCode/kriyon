import { describe, expect, test } from "vitest";
import type { SessionSnapshotRow } from "../ipc/bridge.ts";
import { snapshotGroups } from "./snapshotGroups.ts";

function snap(over: Partial<SessionSnapshotRow>): SessionSnapshotRow {
  const row: SessionSnapshotRow = {
    branch: null,
    memoryMb: null,
    needsYou: false,
    pendingAsk: null,
    projectName: "proj",
    sessionId: "s",
    status: "idle",
    summary: "",
    title: "s",
    ...over,
  };
  // Mirror the backend `session_needs_you` rule so fixtures can keep expressing
  // intent via status/pendingAsk; pass `needsYou` explicitly to test the flag
  // in isolation.
  return {
    ...row,
    needsYou:
      over.needsYou ?? (row.status === "waiting" || row.pendingAsk !== null),
  };
}

describe("snapshotGroups", () => {
  test("waiting status and pendingAsk go to needsYou; running to running; idle omitted", () => {
    const snaps = [
      snap({ sessionId: "a", status: "waiting", title: "globex" }),
      snap({
        sessionId: "b",
        status: "running",
        title: "checkout",
        summary: "Running tests",
      }),
      snap({ sessionId: "c", status: "idle", title: "docs" }),
      snap({
        sessionId: "d",
        status: "running",
        title: "atlas",
        pendingAsk: { askedAt: null, kind: "permission", text: "db migrate" },
      }),
    ];
    const groups = snapshotGroups(snaps, 0);
    // `d` is running-with-ask → needs-you takes precedence over running.
    expect(
      groups.needsYou.map((r) => r.sessionId).sort((a, b) => (a < b ? -1 : 1))
    ).toEqual(["a", "d"]);
    expect(groups.running.map((r) => r.sessionId)).toEqual(["b"]);
  });

  test("running row line is the summary; needs-you pill comes from the ask kind", () => {
    const groups = snapshotGroups(
      [
        snap({
          sessionId: "b",
          status: "running",
          summary: "Editing guide.mdx",
        }),
        snap({
          sessionId: "a",
          status: "waiting",
          pendingAsk: { askedAt: null, kind: "permission", text: "allow curl" },
        }),
      ],
      0
    );
    expect(groups.running[0]?.line).toBe("Editing guide.mdx");
    expect(groups.needsYou[0]?.pill).toBe("ALLOW");
    expect(groups.needsYou[0]?.line).toContain("allow curl");
  });

  test("needsYou is sorted longest-blocked first", () => {
    const groups = snapshotGroups(
      [
        snap({
          sessionId: "recent",
          status: "waiting",
          pendingAsk: {
            askedAt: "2026-07-05T09:00:00.000Z",
            kind: "question",
            text: "x",
          },
        }),
        snap({
          sessionId: "old",
          status: "waiting",
          pendingAsk: {
            askedAt: "2026-07-05T08:50:00.000Z",
            kind: "question",
            text: "y",
          },
        }),
      ],
      Date.parse("2026-07-05T09:02:00.000Z")
    );
    expect(groups.needsYou.map((r) => r.sessionId)).toEqual(["old", "recent"]);
  });
});
