import { beforeEach, describe, expect, it, test, vi } from "vitest";

vi.mock("../ipc/bridge.ts", () => ({
  diffSessionChanges: vi.fn(),
  diffWorkingTree: vi.fn(),
}));

import { diffSessionChanges, diffWorkingTree } from "../ipc/bridge.ts";
import type { FileDiff, SessionDiff } from "../types.ts";
import {
  BASELINE_OBJECT_MISSING_PREFIX,
  computeTotals,
  computeTotalsFromFiles,
  defaultCollapsed,
  fileKind,
  isMissingBaselineObjectError,
  isWorkingTreeTooLargeError,
  useChanges,
  visibleFiles,
  WORKING_TREE_TOO_LARGE_PREFIX,
} from "./changes.ts";

const mockedDiffWorkingTree = vi.mocked(diffWorkingTree);
const mockedDiffSessionChanges = vi.mocked(diffSessionChanges);

function sampleDiff(base = "HEAD", baseSha?: string | null): SessionDiff {
  return {
    base,
    ...(baseSha === undefined ? {} : { baseSha }),
    files: [
      {
        binary: false,
        hunks: [
          {
            header: "@@ -1,2 +1,3 @@",
            lines: [
              { kind: "context", text: "same" },
              { kind: "removed", text: "old" },
              { kind: "added", text: "new" },
              { kind: "added", text: "extra" },
            ],
          },
        ],
        oldPath: null,
        path: "src/main.ts",
        status: "modified",
      },
    ],
  };
}

function emptyEntry() {
  return {
    baselineLabel: "",
    collapsed: {},
    diff: null,
    fetchedAt: 0,
    hunkHashes: {},
    status: "ready" as const,
    totals: null,
    viewed: {},
  };
}

describe("useChanges", () => {
  beforeEach(() => {
    // Reset every per-session map, not just bySession: tests seed activeFile/
    // ui/expandedDirs/etc., and a leftover entry would leak into a later
    // test that expects a clean store.
    useChanges.setState({
      activeFile: {},
      bySession: {},
      dirtyFiles: {},
      expandedDirs: {},
      fileDrafts: {},
      ui: {},
    });
    mockedDiffWorkingTree.mockReset();
    mockedDiffSessionChanges.mockReset();
  });

  it("dropSession forgets every per-session entry so a closed session can't leak", () => {
    useChanges.setState({
      activeFile: { s1: "a.ts", s2: "b.ts" },
      bySession: { s1: emptyEntry(), s2: emptyEntry() },
      dirtyFiles: { s1: "a.ts", s2: null },
      expandedDirs: { s1: { src: true }, s2: {} },
      ui: {
        s1: {
          myEditsOnly: true,
          pendingJump: "a.ts",
          selectedFile: "a.ts",
          tab: "all",
        },
        s2: { tab: "changes" },
      },
    });

    useChanges.getState().dropSession("s1");

    const state = useChanges.getState();
    expect(state.bySession.s1).toBeUndefined();
    expect(state.activeFile.s1).toBeUndefined();
    expect(state.dirtyFiles).not.toHaveProperty("s1");
    expect(state.expandedDirs.s1).toBeUndefined();
    expect(state.ui).not.toHaveProperty("s1");
    // The other session is untouched.
    expect(state.bySession.s2).toBeDefined();
    expect(state.activeFile.s2).toBe("b.ts");
    expect(state.dirtyFiles.s2).toBeNull();
    expect(state.ui.s2?.tab).toBe("changes");
  });

  it("setDirtyFile publishes the live dirty path for a session", () => {
    useChanges.getState().setDirtyFile("s1", "src/a.ts");
    expect(useChanges.getState().dirtyFiles.s1).toBe("src/a.ts");

    useChanges.getState().setDirtyFile("s1", null);
    expect(useChanges.getState().dirtyFiles.s1).toBeNull();
  });

  it("setActiveFile records the feed's most-visible file per session", () => {
    useChanges.setState({ activeFile: {} });

    useChanges.getState().setActiveFile("s1", "src/a.ts");

    expect(useChanges.getState().activeFile.s1).toBe("src/a.ts");
  });

  it("setActiveFile no-ops (keeps the same state object) when unchanged", () => {
    useChanges.setState({ activeFile: { s1: "src/a.ts" } });
    const before = useChanges.getState().activeFile;

    useChanges.getState().setActiveFile("s1", "src/a.ts");

    // Same reference back — a scroll that doesn't cross a card boundary must
    // not churn the store (and re-render JumpRail's subscribers).
    expect(useChanges.getState().activeFile).toBe(before);
  });

  it("refresh populates diff, totals, and baselineLabel on success", async () => {
    mockedDiffWorkingTree.mockResolvedValue(sampleDiff());

    await useChanges.getState().refresh("s1", "/repo");

    const entry = useChanges.getState().bySession.s1;
    expect(entry).toBeDefined();
    expect(entry?.status).toBe("ready");
    expect(entry?.diff).toEqual(sampleDiff());
    expect(entry?.totals).toEqual({ files: 1, additions: 2, deletions: 1 });
    expect(entry?.baselineLabel).toBe("HEAD · uncommitted");
    expect(entry?.fetchedAt).toBeGreaterThan(0);
    expect(mockedDiffWorkingTree).toHaveBeenCalledWith("/repo", undefined);
  });

  it("refresh with an explicit base produces a branch-shaped baselineLabel", async () => {
    mockedDiffWorkingTree.mockResolvedValue(sampleDiff("main"));

    await useChanges.getState().refresh("s1", "/repo", { base: "main" });

    const entry = useChanges.getState().bySession.s1;
    expect(entry?.baselineLabel).toContain("main");
    expect(entry?.baselineLabel).not.toBe("HEAD · uncommitted");
    expect(mockedDiffWorkingTree).toHaveBeenCalledWith("/repo", "main");
  });

  it("baselineLabel includes the resolved short sha when the diff reports one", async () => {
    mockedDiffWorkingTree.mockResolvedValue(sampleDiff("main", "abc1234"));

    await useChanges.getState().refresh("s1", "/repo", { base: "main" });

    const entry = useChanges.getState().bySession.s1;
    expect(entry?.baselineLabel).toBe("main @ abc1234");
  });

  it("baselineLabel degrades to just the base name when no sha is resolved", async () => {
    mockedDiffWorkingTree.mockResolvedValue(sampleDiff("main", null));

    await useChanges.getState().refresh("s1", "/repo", { base: "main" });

    const entry = useChanges.getState().bySession.s1;
    expect(entry?.baselineLabel).toBe("main");
    expect(entry?.baselineLabel).not.toContain("@");
  });

  it("the plain-session baselineLabel stays 'HEAD · uncommitted' even if a sha is reported", async () => {
    mockedDiffWorkingTree.mockResolvedValue(sampleDiff("HEAD", "abc1234"));

    await useChanges.getState().refresh("s1", "/repo");

    const entry = useChanges.getState().bySession.s1;
    expect(entry?.baselineLabel).toBe("HEAD · uncommitted");
  });

  it("several refreshes arriving during one in-flight run coalesce into exactly one trailing re-run", async () => {
    let resolveDiff!: (value: SessionDiff) => void;
    mockedDiffWorkingTree.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveDiff = resolve;
      })
    );
    mockedDiffWorkingTree.mockResolvedValue(sampleDiff());

    const first = useChanges.getState().refresh("s1", "/repo");
    const queued = [
      useChanges.getState().refresh("s1", "/repo"),
      useChanges.getState().refresh("s1", "/repo"),
      useChanges.getState().refresh("s1", "/repo"),
    ];

    resolveDiff(sampleDiff());
    await Promise.all([first, ...queued]);

    // Three requests landed mid-flight: they must not each queue a run of
    // their own (that's the unbounded case), but they must not be dropped
    // either (that's the stale-result bug) — exactly one follow-up covers
    // all three.
    expect(mockedDiffWorkingTree).toHaveBeenCalledTimes(2);
  });

  it("a refresh arriving mid-flight is re-run afterwards, so the newest state — not the stale in-flight one — is what lands", async () => {
    // The in-flight run's `snapshot_tree` already ran before the change that
    // triggered the second request, so its result predates that change:
    // returning the older promise and dropping the newer request leaves the
    // view stale with nothing left to re-arm it.
    let resolveStale!: (value: SessionDiff) => void;
    const fresh = sampleDiff();
    fresh.files.push({
      binary: false,
      hunks: [],
      oldPath: null,
      path: "src/late.ts",
      status: "added",
    });
    mockedDiffWorkingTree.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveStale = resolve;
      })
    );
    mockedDiffWorkingTree.mockResolvedValue(fresh);

    const first = useChanges.getState().refresh("s1", "/repo");
    const second = useChanges.getState().refresh("s1", "/repo");

    resolveStale(sampleDiff());
    await Promise.all([first, second]);

    // Awaiting either handle must mean "the newest requested state has
    // landed" — this is what makes FileViewer's save→refresh honest.
    expect(
      useChanges.getState().bySession.s1?.diff?.files.map((f) => f.path)
    ).toContain("src/late.ts");
  });

  it("the trailing re-run uses the newest request's cwd and options, not the in-flight one's", async () => {
    let resolveDiff!: (value: SessionDiff) => void;
    mockedDiffWorkingTree.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveDiff = resolve;
      })
    );
    mockedDiffWorkingTree.mockResolvedValue(sampleDiff("main"));

    const first = useChanges.getState().refresh("s1", "/repo");
    const second = useChanges
      .getState()
      .refresh("s1", "/repo-wt", { base: "main" });

    resolveDiff(sampleDiff());
    await Promise.all([first, second]);

    expect(mockedDiffWorkingTree).toHaveBeenLastCalledWith("/repo-wt", "main");
  });

  it("a trailing re-run still settles (and cleans up) when the in-flight run fails", async () => {
    let rejectFirst!: (err: Error) => void;
    mockedDiffWorkingTree.mockReturnValueOnce(
      new Promise((_resolve, reject) => {
        rejectFirst = reject;
      })
    );
    mockedDiffWorkingTree.mockResolvedValue(sampleDiff());

    const first = useChanges.getState().refresh("s1", "/repo");
    const second = useChanges.getState().refresh("s1", "/repo");

    rejectFirst(new Error("git exploded"));
    await Promise.all([first, second]);

    expect(mockedDiffWorkingTree).toHaveBeenCalledTimes(2);
    expect(useChanges.getState().bySession.s1?.status).toBe("ready");
    // `inFlight` was cleaned up too — a later refresh isn't wedged behind a
    // settled promise that never clears.
    await useChanges.getState().refresh("s1", "/repo");
    expect(mockedDiffWorkingTree).toHaveBeenCalledTimes(3);
  });

  it("a failed refresh sets status to error with a message", async () => {
    mockedDiffWorkingTree.mockRejectedValue(new Error("git exploded"));

    await useChanges.getState().refresh("s1", "/repo");

    const entry = useChanges.getState().bySession.s1;
    expect(entry?.status).toBe("error");
    expect(entry?.error).toBe("git exploded");
  });

  it("a failed refresh leaves fetchedAt at 0 when no fetch has ever succeeded", async () => {
    mockedDiffWorkingTree.mockRejectedValue(new Error("git exploded"));

    await useChanges.getState().refresh("s1", "/repo");

    expect(useChanges.getState().bySession.s1?.fetchedAt).toBe(0);
  });

  it("a failed refresh does not advance fetchedAt past the last successful fetch", async () => {
    // A real clock could tick the same millisecond twice across these two
    // awaited calls, making a plain Date.now()-based assertion pass by
    // accident even against the bug this guards (stamping fetchedAt in the
    // catch branch too) — advance a fake clock between them so the two
    // timestamps are unambiguously distinct if the bug were present.
    vi.useFakeTimers();
    try {
      mockedDiffWorkingTree.mockResolvedValue(sampleDiff());
      await useChanges.getState().refresh("s1", "/repo");
      const successfulFetchedAt = useChanges.getState().bySession.s1?.fetchedAt;

      vi.advanceTimersByTime(60_000);
      mockedDiffWorkingTree.mockRejectedValue(new Error("git exploded"));
      await useChanges.getState().refresh("s1", "/repo");

      const entry = useChanges.getState().bySession.s1;
      expect(entry?.status).toBe("error");
      expect(entry?.fetchedAt).toBe(successfulFetchedAt);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a failed refresh preserves the diff and totals from the last successful fetch", async () => {
    mockedDiffWorkingTree.mockResolvedValue(sampleDiff());
    await useChanges.getState().refresh("s1", "/repo");
    const { diff: successfulDiff, totals: successfulTotals } =
      useChanges.getState().bySession.s1 ?? {};

    mockedDiffWorkingTree.mockRejectedValue(new Error("git exploded"));
    await useChanges.getState().refresh("s1", "/repo");

    const entry = useChanges.getState().bySession.s1;
    expect(entry?.diff).toEqual(successfulDiff);
    expect(entry?.totals).toEqual(successfulTotals);
  });

  it("collapsed state survives a refresh", async () => {
    mockedDiffWorkingTree.mockResolvedValue(sampleDiff());
    await useChanges.getState().refresh("s1", "/repo");

    const [mainFile] = sampleDiff().files;
    useChanges.getState().toggleCollapsed("s1", mainFile.path);
    expect(useChanges.getState().bySession.s1?.collapsed["src/main.ts"]).toBe(
      true
    );

    await useChanges.getState().refresh("s1", "/repo");

    expect(useChanges.getState().bySession.s1?.collapsed["src/main.ts"]).toBe(
      true
    );
  });

  it("toggleCollapsed flips a file's collapsed flag back and forth", async () => {
    mockedDiffWorkingTree.mockResolvedValue(sampleDiff());
    await useChanges.getState().refresh("s1", "/repo");

    const [mainFile] = sampleDiff().files;
    useChanges.getState().toggleCollapsed("s1", mainFile.path);
    expect(useChanges.getState().bySession.s1?.collapsed["src/main.ts"]).toBe(
      true
    );

    useChanges.getState().toggleCollapsed("s1", mainFile.path);
    expect(useChanges.getState().bySession.s1?.collapsed["src/main.ts"]).toBe(
      false
    );
  });

  it("toggleCollapsed flips against the effective (not raw) collapsed state, so a lockfile expands on the first click", () => {
    const lockfile: FileDiff = {
      binary: false,
      hunks: [
        {
          header: "@@ -1,1 +1,1 @@",
          lines: [{ kind: "context", text: "line" }],
        },
      ],
      oldPath: null,
      path: "pnpm-lock.yaml",
      status: "modified",
    };

    // Seed the store the way production always has it: the file the user
    // clicked is already in `bySession[id].diff.files` (this is the
    // pre-existing pattern other tests in this file use, e.g. "collapsed
    // state survives a refresh" above).
    useChanges.setState({
      bySession: {
        s1: {
          baselineLabel: "HEAD · uncommitted",
          collapsed: {},
          diff: { base: "HEAD", files: [lockfile] },
          fetchedAt: Date.now(),
          hunkHashes: {},
          status: "ready",
          totals: null,
          viewed: {},
        },
      },
    });

    // Never toggled: defaultCollapsed(lockfile) is true, so a single
    // toggle must flip it to *expanded* (false) — not collapse it further.
    useChanges.getState().toggleCollapsed("s1", lockfile.path);
    expect(
      useChanges.getState().bySession.s1?.collapsed["pnpm-lock.yaml"]
    ).toBe(false);
  });

  it("toggleCollapsed falls back to a not-auto-collapsed default when the path isn't in the store yet", () => {
    // No refresh, no seeded diff: the file the click named isn't resolvable
    // via `bySession[id].diff.files` (e.g. a stale click racing an
    // in-flight refresh). The toggle must still flip something sane rather
    // than silently no-op'ing.
    useChanges.getState().toggleCollapsed("s1", "untracked.ts");
    expect(useChanges.getState().bySession.s1?.collapsed["untracked.ts"]).toBe(
      true
    );
  });

  it("setAllCollapsed(true) collapses every file currently in the diff at once", async () => {
    const diff: SessionDiff = {
      base: "HEAD",
      files: [
        ...sampleDiff().files,
        {
          binary: false,
          hunks: [{ header: "@@ -1,1 +1,1 @@", lines: [] }],
          oldPath: null,
          path: "src/other.ts",
          status: "modified",
        },
      ],
    };
    mockedDiffWorkingTree.mockResolvedValue(diff);
    await useChanges.getState().refresh("s1", "/repo");

    useChanges.getState().setAllCollapsed("s1", true);

    const { collapsed } = useChanges.getState().bySession.s1 ?? {};
    expect(collapsed?.["src/main.ts"]).toBe(true);
    expect(collapsed?.["src/other.ts"]).toBe(true);
  });

  it("setAllCollapsed(false) expands every file, undoing a prior collapse-all", async () => {
    mockedDiffWorkingTree.mockResolvedValue(sampleDiff());
    await useChanges.getState().refresh("s1", "/repo");

    useChanges.getState().setAllCollapsed("s1", true);
    useChanges.getState().setAllCollapsed("s1", false);

    expect(useChanges.getState().bySession.s1?.collapsed["src/main.ts"]).toBe(
      false
    );
  });

  it("a per-file toggle after setAllCollapsed still overrides it", async () => {
    mockedDiffWorkingTree.mockResolvedValue(sampleDiff());
    await useChanges.getState().refresh("s1", "/repo");

    useChanges.getState().setAllCollapsed("s1", true);
    useChanges.getState().toggleCollapsed("s1", "src/main.ts");

    expect(useChanges.getState().bySession.s1?.collapsed["src/main.ts"]).toBe(
      false
    );
  });

  it("setAllCollapsed is a no-op when the session has no diff yet", () => {
    useChanges.getState().setAllCollapsed("unknown", true);
    expect(useChanges.getState().bySession.unknown).toBeUndefined();
  });

  it("sets status to loading synchronously when refresh starts", () => {
    let resolveDiff!: (value: SessionDiff) => void;
    mockedDiffWorkingTree.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveDiff = resolve;
      })
    );

    const pending = useChanges.getState().refresh("s1", "/repo");
    expect(useChanges.getState().bySession.s1?.status).toBe("loading");

    resolveDiff(sampleDiff());
    return pending;
  });
});

describe("refresh source selection (baseline vs fallback)", () => {
  beforeEach(() => {
    useChanges.setState({ bySession: {} });
    mockedDiffWorkingTree.mockReset();
    mockedDiffSessionChanges.mockReset();
  });

  it("uses diff_session_changes when the session has a baseline oid", async () => {
    mockedDiffSessionChanges.mockResolvedValue(sampleDiff());

    await useChanges
      .getState()
      .refresh("s1", "/repo", { baselineOid: "cafebabe" });

    expect(mockedDiffSessionChanges).toHaveBeenCalledWith("/repo", "cafebabe");
    expect(mockedDiffWorkingTree).not.toHaveBeenCalled();
  });

  it("falls back to diff_working_tree when there is no baseline oid", async () => {
    mockedDiffWorkingTree.mockResolvedValue(sampleDiff("main"));

    await useChanges
      .getState()
      .refresh("s1", "/repo", { base: "main", baselineOid: null });

    expect(mockedDiffWorkingTree).toHaveBeenCalledWith("/repo", "main");
    expect(mockedDiffSessionChanges).not.toHaveBeenCalled();
  });

  it("a baseline-anchored refresh produces a sensible, non-HEAD baselineLabel", async () => {
    mockedDiffSessionChanges.mockResolvedValue(
      sampleDiff("cafebabefeed", "cafebabe")
    );

    await useChanges
      .getState()
      .refresh("s1", "/repo", { baselineOid: "cafebabefeed" });

    const entry = useChanges.getState().bySession.s1;
    expect(entry?.baselineLabel).not.toBe("HEAD · uncommitted");
    expect(entry?.baselineLabel).toContain("cafebabe");
  });

  it("M3: a baseline-anchored baselineLabel is tagged as a snapshot, not shaped like a commit sha", async () => {
    // Regression test: `resolve_short_sha` on a `baselineOid` resolves a
    // TREE oid, not a commit — `git show <that sha>` gives a tree listing.
    // The old `"session start @ <sha>"` format borrowed the exact "<ref> @
    // <shortSha>" shape the legacy path uses for a real commit sha, which
    // misleads a user who tries to look it up expecting commit semantics.
    mockedDiffSessionChanges.mockResolvedValue(
      sampleDiff("cafebabefeed", "cafebabe")
    );

    await useChanges
      .getState()
      .refresh("s1", "/repo", { baselineOid: "cafebabefeed" });

    expect(useChanges.getState().bySession.s1?.baselineLabel).toBe(
      "session start · snapshot cafebabe"
    );
  });

  it("a baseline-anchored refresh degrades gracefully when no sha resolves", async () => {
    mockedDiffSessionChanges.mockResolvedValue(
      sampleDiff("cafebabefeed", null)
    );

    await useChanges
      .getState()
      .refresh("s1", "/repo", { baselineOid: "cafebabefeed" });

    const entry = useChanges.getState().bySession.s1;
    expect(entry?.baselineLabel).not.toBe("HEAD · uncommitted");
    expect(entry?.baselineLabel).not.toContain("@");
  });

  it("concurrent baseline refresh calls for the same session still coalesce (one in-flight run plus one trailing re-run)", async () => {
    let resolveDiff!: (value: SessionDiff) => void;
    mockedDiffSessionChanges.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveDiff = resolve;
      })
    );
    mockedDiffSessionChanges.mockResolvedValue(sampleDiff());

    const first = useChanges
      .getState()
      .refresh("s1", "/repo", { baselineOid: "cafebabe" });
    const second = useChanges
      .getState()
      .refresh("s1", "/repo", { baselineOid: "cafebabe" });
    const third = useChanges
      .getState()
      .refresh("s1", "/repo", { baselineOid: "cafebabe" });

    resolveDiff(sampleDiff());
    await Promise.all([first, second, third]);

    expect(mockedDiffSessionChanges).toHaveBeenCalledTimes(2);
  });

  it("two different sessions refreshing concurrently (one baseline, one fallback) don't collide", async () => {
    let resolveBaseline!: (value: SessionDiff) => void;
    let resolveFallback!: (value: SessionDiff) => void;
    mockedDiffSessionChanges.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveBaseline = resolve;
      })
    );
    mockedDiffWorkingTree.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveFallback = resolve;
      })
    );

    const s1 = useChanges
      .getState()
      .refresh("s1", "/repo", { baselineOid: "cafebabe" });
    const s2 = useChanges
      .getState()
      .refresh("s2", "/repo2", { baselineOid: null });

    resolveBaseline(sampleDiff());
    resolveFallback(sampleDiff());
    await Promise.all([s1, s2]);

    expect(mockedDiffSessionChanges).toHaveBeenCalledTimes(1);
    expect(mockedDiffWorkingTree).toHaveBeenCalledTimes(1);
    expect(useChanges.getState().bySession.s1?.status).toBe("ready");
    expect(useChanges.getState().bySession.s2?.status).toBe("ready");
  });

  it("a failed baseline refresh does not advance fetchedAt past the last successful fetch", async () => {
    vi.useFakeTimers();
    try {
      mockedDiffSessionChanges.mockResolvedValue(sampleDiff());
      await useChanges
        .getState()
        .refresh("s1", "/repo", { baselineOid: "cafebabe" });
      const successfulFetchedAt = useChanges.getState().bySession.s1?.fetchedAt;

      vi.advanceTimersByTime(60_000);
      mockedDiffSessionChanges.mockRejectedValue(new Error("git exploded"));
      await useChanges
        .getState()
        .refresh("s1", "/repo", { baselineOid: "cafebabe" });

      const entry = useChanges.getState().bySession.s1;
      expect(entry?.status).toBe("error");
      expect(entry?.fetchedAt).toBe(successfulFetchedAt);
    } finally {
      vi.useRealTimers();
    }
  });

  // I1 (round-two review, BLOCKER): a `baselineOid` is a dangling tree
  // object by construction, so `git gc --prune=now`/`git repack -ad`/the
  // default two-week `gc.pruneExpire` WILL eventually collect it —
  // `diff_session_changes` then fails with `fatal: bad object <oid>`
  // forever, unless this refresh degrades and the caller stops retrying it.
  describe("pruned baseline object (I1)", () => {
    it("falls back to diff_working_tree and reports the baseline as invalid when the baseline object was pruned", async () => {
      mockedDiffSessionChanges.mockRejectedValue(
        new Error(
          "kind:baseline-pruned: baseline object missing: fatal: bad object cafebabefeed"
        )
      );
      mockedDiffWorkingTree.mockResolvedValue(sampleDiff("HEAD"));
      const onBaselineInvalid = vi.fn();

      await useChanges.getState().refresh("s1", "/repo", {
        baselineOid: "cafebabefeed",
        onBaselineInvalid,
      });

      expect(onBaselineInvalid).toHaveBeenCalledTimes(1);
      expect(mockedDiffWorkingTree).toHaveBeenCalledWith("/repo", undefined);
      const entry = useChanges.getState().bySession.s1;
      expect(entry?.status).toBe("ready");
      // The degraded refresh used HEAD, not the pruned baseline — the label
      // must say so, not still claim "session start".
      expect(entry?.baselineLabel).toBe("HEAD · uncommitted");
    });

    it("threads `base` through to the diff_working_tree fallback for a worktree session", async () => {
      mockedDiffSessionChanges.mockRejectedValue(
        new Error(
          "kind:baseline-pruned: baseline object missing: fatal: bad object cafebabefeed"
        )
      );
      mockedDiffWorkingTree.mockResolvedValue(sampleDiff("main"));

      await useChanges.getState().refresh("s1", "/repo", {
        base: "main",
        baselineOid: "cafebabefeed",
        onBaselineInvalid: vi.fn(),
      });

      expect(mockedDiffWorkingTree).toHaveBeenCalledWith("/repo", "main");
      expect(useChanges.getState().bySession.s1?.baselineLabel).toBe("main");
    });

    it("does not call onBaselineInvalid, and does not fall back, for a diff_session_changes failure unrelated to a missing object", async () => {
      mockedDiffSessionChanges.mockRejectedValue(
        new Error("git exploded for some other reason")
      );
      const onBaselineInvalid = vi.fn();

      await useChanges.getState().refresh("s1", "/repo", {
        baselineOid: "cafebabefeed",
        onBaselineInvalid,
      });

      expect(onBaselineInvalid).not.toHaveBeenCalled();
      expect(mockedDiffWorkingTree).not.toHaveBeenCalled();
      expect(useChanges.getState().bySession.s1?.status).toBe("error");
    });

    it("still surfaces an error (does not loop forever) if the diff_working_tree fallback itself also fails", async () => {
      mockedDiffSessionChanges.mockRejectedValue(
        new Error(
          "kind:baseline-pruned: baseline object missing: fatal: bad object cafebabefeed"
        )
      );
      mockedDiffWorkingTree.mockRejectedValue(new Error("no git repo here"));

      await useChanges.getState().refresh("s1", "/repo", {
        baselineOid: "cafebabefeed",
        onBaselineInvalid: vi.fn(),
      });

      const entry = useChanges.getState().bySession.s1;
      expect(entry?.status).toBe("error");
      expect(entry?.error).toBe("no git repo here");
    });
  });
});

describe("working tree over the [Working-tree budget] (snapshot refused)", () => {
  it("degrades to diff_working_tree, which reports the refusal instead of erroring", async () => {
    mockedDiffSessionChanges.mockRejectedValue(
      new Error(
        "kind:over-budget: working tree too large: over 10000 untracked files (mostly opt/)"
      )
    );
    const refused: SessionDiff = {
      ...sampleDiff("HEAD"),
      budgetExceeded: {
        fileLimit: 10_000,
        untrackedDirs: ["opt/"],
        untrackedFiles: 10_268,
      },
    };
    mockedDiffWorkingTree.mockResolvedValue(refused);

    await useChanges.getState().refresh("s1", "/repo", {
      baselineOid: "cafebabefeed",
      onBaselineInvalid: vi.fn(),
    });

    const entry = useChanges.getState().bySession.s1;
    expect(entry?.status).toBe("ready");
    expect(entry?.diff?.budgetExceeded?.untrackedDirs).toEqual(["opt/"]);
  });

  /**
   * The distinction from the pruned-baseline degrade next door: that one
   * clears the stored oid because the object is gone for good. This one says
   * nothing about the baseline — the object is fine, the tree is temporarily
   * too big — so clearing it would throw away a still-valid anchor and
   * permanently downgrade the session to the HEAD diff even after the user
   * gitignores the offending directory.
   */
  it("keeps the session's baseline, unlike the pruned-object degrade", async () => {
    mockedDiffSessionChanges.mockRejectedValue(
      new Error(
        "kind:over-budget: working tree too large: over 10000 untracked files"
      )
    );
    mockedDiffWorkingTree.mockResolvedValue(sampleDiff("HEAD"));
    const onBaselineInvalid = vi.fn();

    await useChanges.getState().refresh("s1", "/repo", {
      baselineOid: "cafebabefeed",
      onBaselineInvalid,
    });

    expect(onBaselineInvalid).not.toHaveBeenCalled();
    expect(mockedDiffWorkingTree).toHaveBeenCalledWith("/repo", undefined);
  });

  it("matches the exact frozen contract prefix", () => {
    // Contract pin: byte-identical to git_cmd.rs's
    // WORKING_TREE_TOO_LARGE_PREFIX, frozen there by
    // `working_tree_too_large_prefix_is_the_frozen_contract_string`. This is
    // the display half only now (see `failureMessage`) — classification runs
    // on the `"kind:over-budget: "` leader, pinned separately below.
    expect(WORKING_TREE_TOO_LARGE_PREFIX).toBe("working tree too large: ");
  });

  it("does not mistake the pruned-baseline tag for this one", () => {
    expect(
      isWorkingTreeTooLargeError(
        new Error(
          "kind:baseline-pruned: baseline object missing: fatal: bad object cafebabe"
        )
      )
    ).toBe(false);
    expect(
      isWorkingTreeTooLargeError(
        new Error("kind:over-budget: working tree too large: over 10000")
      )
    ).toBe(true);
  });

  it("no longer matches the bare, untagged prefix (pre-Command-failure-kind shape)", () => {
    // The migration boundary: before ADR-0006's addendum, this classifier
    // matched the prefix directly. It now requires Rust's `tagged_failure`
    // leader — a message carrying only the old prefix must classify as
    // "unknown", not silently keep matching by accident.
    expect(
      isWorkingTreeTooLargeError(
        new Error("working tree too large: over 10000")
      )
    ).toBe(false);
  });
});

describe("isMissingBaselineObjectError", () => {
  it("matches only the frontend/Rust-shared tagged leader", () => {
    expect(
      isMissingBaselineObjectError(
        new Error(
          "kind:baseline-pruned: baseline object missing: fatal: bad object cafebabe"
        )
      )
    ).toBe(true);
    expect(
      isMissingBaselineObjectError(
        "kind:baseline-pruned: baseline object missing: x"
      )
    ).toBe(true);
    expect(isMissingBaselineObjectError(new Error("fatal: bad object x"))).toBe(
      false
    );
    expect(isMissingBaselineObjectError(new Error("some other error"))).toBe(
      false
    );
    expect(isMissingBaselineObjectError("plain string, untagged")).toBe(false);
    // The bare, untagged prefix (pre-Command-failure-kind shape) no longer
    // classifies on its own — see the sibling test in the `overBudget`
    // describe block above.
    expect(
      isMissingBaselineObjectError(
        new Error("baseline object missing: fatal: bad object cafebabe")
      )
    ).toBe(false);
  });

  it("matches the exact frozen contract prefix", () => {
    // Contract pin (B4): must be byte-identical to git_cmd.rs's
    // BASELINE_OBJECT_MISSING_PREFIX (frozen there by
    // `baseline_object_missing_prefix_is_the_frozen_contract_string`). No
    // shared codegen crosses the Rust↔JS boundary, so this freezes the JS
    // literal; change one side and its pin fails, telling you to change both.
    expect(BASELINE_OBJECT_MISSING_PREFIX).toBe("baseline object missing: ");
  });
});

/** {@link sampleDiff} plus a true noise file (a zero-hunk, non-binary
 * `modified` entry — see `isNoiseFile`), so a "does this filter?" assertion
 * has something to actually filter. */
function diffWithNoise(): SessionDiff {
  const diff = sampleDiff();
  diff.files.push({
    binary: false,
    hunks: [],
    oldPath: null,
    path: "mode-only.ts",
    status: "modified",
  });
  return diff;
}

describe("computeTotalsFromFiles", () => {
  it("sums additions/deletions across the given files directly, independent of any SessionDiff", () => {
    const { files } = sampleDiff();
    expect(computeTotalsFromFiles(files)).toEqual({
      additions: 2,
      deletions: 1,
      files: 1,
    });
  });

  it("is what computeTotals delegates to over visibleFiles(diff) — not over diff.files raw", () => {
    // The fixture must actually contain a noise file, or this assertion is
    // vacuous: over a noise-free diff, `visibleFiles(diff)` and `diff.files`
    // are the same list, so it passes whether or not `computeTotals`
    // filters at all.
    const diff = diffWithNoise();

    expect(computeTotals(diff)).toEqual(
      computeTotalsFromFiles(visibleFiles(diff))
    );
    // And the two lists genuinely disagree here — the noise file is a real
    // extra entry in `diff.files` that must not reach the totals.
    expect(computeTotalsFromFiles(diff.files)).not.toEqual(computeTotals(diff));
    expect(computeTotals(diff).files).toBe(1);
  });

  it("returns zero totals for an empty file list", () => {
    expect(computeTotalsFromFiles([])).toEqual({
      additions: 0,
      deletions: 0,
      files: 0,
    });
  });
});

describe("viewed state", () => {
  it("markViewed sets a file's viewed flag", () => {
    useChanges.getState().markViewed("s1", "src/main.ts");
    expect(useChanges.getState().bySession.s1?.viewed["src/main.ts"]).toBe(
      true
    );
  });

  it("refresh preserves viewed state for a file whose hunk content is unchanged", async () => {
    mockedDiffWorkingTree.mockResolvedValue(sampleDiff());
    await useChanges.getState().refresh("s1", "/repo");
    useChanges.getState().markViewed("s1", "src/main.ts");

    await useChanges.getState().refresh("s1", "/repo");

    expect(useChanges.getState().bySession.s1?.viewed["src/main.ts"]).toBe(
      true
    );
  });

  it("refresh clears viewed state for a file whose hunk content changed", async () => {
    mockedDiffWorkingTree.mockResolvedValue(sampleDiff());
    await useChanges.getState().refresh("s1", "/repo");
    useChanges.getState().markViewed("s1", "src/main.ts");

    const changed = sampleDiff();
    changed.files[0].hunks[0].lines.push({ kind: "added", text: "yet more" });
    mockedDiffWorkingTree.mockResolvedValue(changed);
    await useChanges.getState().refresh("s1", "/repo");

    expect(
      useChanges.getState().bySession.s1?.viewed["src/main.ts"]
    ).toBeUndefined();
  });

  it("a file freshly loaded by a refresh starts unviewed", async () => {
    mockedDiffWorkingTree.mockResolvedValue(sampleDiff());
    await useChanges.getState().refresh("s1", "/repo");

    expect(
      useChanges.getState().bySession.s1?.viewed["src/main.ts"]
    ).toBeUndefined();
  });

  it("a second markViewed call on an already-viewed file is a no-op (stays true)", () => {
    useChanges.getState().markViewed("s1", "src/main.ts");
    useChanges.getState().markViewed("s1", "src/main.ts");
    expect(useChanges.getState().bySession.s1?.viewed["src/main.ts"]).toBe(
      true
    );
  });
});

function fileWithChangedLines(count: number): FileDiff {
  return {
    binary: false,
    hunks: [
      {
        header: `@@ -1,${count} +1,${count} @@`,
        lines: Array.from({ length: count }, () => ({
          kind: "added" as const,
          text: "x",
        })),
      },
    ],
    oldPath: null,
    path: "src/big.ts",
    status: "modified",
  };
}

describe("defaultCollapsed", () => {
  it("does not auto-collapse a file at exactly the 400-changed-line threshold", () => {
    expect(defaultCollapsed(fileWithChangedLines(400))).toBe(false);
  });

  it("auto-collapses a file one line past the 400-changed-line threshold", () => {
    expect(defaultCollapsed(fileWithChangedLines(401))).toBe(true);
  });
});

describe("visibleFiles / fileKind / computeTotals", () => {
  // Deviation from the brief's pseudocode: `FileChange` (types.ts) is
  // lowercase ("modified"/"added"/"deleted"/"renamed") and `oldPath` is
  // `string | null`, not `undefined` — adapted here to satisfy
  // `SessionDiff`/`FileDiff` so `pnpm typecheck` stays clean; the scenario
  // and assertions are otherwise verbatim from the brief.
  function noiseFixtureDiff(): SessionDiff {
    return {
      base: "x",
      baseSha: null,
      files: [
        {
          binary: false,
          hunks: [],
          oldPath: null,
          path: "noise.ts",
          status: "modified",
        },
        {
          binary: true,
          hunks: [],
          oldPath: null,
          path: "img.png",
          status: "modified",
        },
        {
          binary: false,
          hunks: [],
          oldPath: "old.rs",
          path: "new.rs",
          status: "renamed",
        },
        {
          binary: false,
          hunks: [],
          oldPath: null,
          path: "empty.txt",
          status: "added",
        },
        {
          binary: false,
          hunks: [
            { header: "@@ -1 +1,2 @@", lines: [{ kind: "added", text: "y" }] },
          ],
          oldPath: null,
          path: "real.ts",
          status: "modified",
        },
      ],
    };
  }

  it("drops zero-change non-binary modified noise but keeps binary/rename/empty", () => {
    const diff = noiseFixtureDiff();

    const vis = visibleFiles(diff).map((f) => f.path);
    expect(vis).toEqual(["img.png", "new.rs", "empty.txt", "real.ts"]); // noise.ts dropped

    const totals = computeTotals(diff);
    expect(totals.files).toBe(4);
  });

  it("fileKind classifies each of the five cases", () => {
    const [noise, img, renamed, empty, real] = noiseFixtureDiff().files;
    expect(fileKind(img)).toBe("binary");
    expect(fileKind(renamed)).toBe("rename");
    expect(fileKind(empty)).toBe("empty");
    expect(fileKind(real)).toBe("content");
    // Noise isn't a `fileKind` bucket of its own — it's excluded by
    // `visibleFiles` before `fileKind` would ever be asked about it — but
    // the classifier still resolves it (falls through to "content") rather
    // than throwing, since nothing guarantees a caller only ever passes it
    // already-filtered files.
    expect(fileKind(noise)).toBe("content");
  });

  it("computeTotals excludes noise's zero lines but still sums a real file's", () => {
    const totals = computeTotals(noiseFixtureDiff());
    expect(totals.additions).toBe(1);
    expect(totals.deletions).toBe(0);
  });
});

describe("pendingJump", () => {
  beforeEach(() => {
    useChanges.setState({ ui: {} });
  });

  it("requestJump records a pending path for that session only", () => {
    useChanges.getState().requestJump("s1", "src/a.ts");

    expect(useChanges.getState().ui.s1?.pendingJump).toBe("src/a.ts");
    expect(useChanges.getState().ui.s2?.pendingJump).toBeUndefined();
  });

  it("consumeJump clears the pending path", () => {
    useChanges.getState().requestJump("s1", "src/a.ts");
    useChanges.getState().consumeJump("s1");

    expect(useChanges.getState().ui.s1?.pendingJump).toBeUndefined();
  });

  it("a later requestJump replaces an unconsumed one", () => {
    useChanges.getState().requestJump("s1", "src/a.ts");
    useChanges.getState().requestJump("s1", "src/b.ts");

    expect(useChanges.getState().ui.s1?.pendingJump).toBe("src/b.ts");
  });
});

test("the tab defaults to changes and can be switched per session", () => {
  expect(useChanges.getState().ui.s1?.tab).toBeUndefined();

  useChanges.getState().setTab("s1", "all");

  expect(useChanges.getState().ui.s1?.tab).toBe("all");
  expect(useChanges.getState().ui.s2?.tab).toBeUndefined();
});

test("switching tabs preserves the selected file — FileViewer stays mounted, just hidden, per ChangesView's display-toggle", () => {
  useChanges.getState().setTab("s1", "all");
  useChanges.getState().selectFile("s1", "src/a.ts");

  useChanges.getState().setTab("s1", "changes");
  expect(useChanges.getState().ui.s1?.selectedFile).toBe("src/a.ts");

  useChanges.getState().setTab("s1", "all");
  expect(useChanges.getState().ui.s1?.selectedFile).toBe("src/a.ts");
});

test("toggleDir expands then collapses a directory", () => {
  useChanges.getState().toggleDir("s1", "src");
  expect(useChanges.getState().expandedDirs.s1?.src).toBe(true);

  useChanges.getState().toggleDir("s1", "src");
  expect(useChanges.getState().expandedDirs.s1?.src).toBe(false);
});

test("collapseAllDirs closes every open folder in the session's file tree", () => {
  const store = useChanges.getState();
  store.toggleDir("s1", "src");
  store.toggleDir("s1", "src/ui");
  store.toggleDir("s2", "docs");
  store.collapseAllDirs("s1");
  expect(useChanges.getState().expandedDirs.s1).toEqual({});
  // Another session's tree is its own.
  expect(useChanges.getState().expandedDirs.s2?.docs).toBe(true);
});

test("expandToPath opens every folder above a file, and leaves others alone", () => {
  const store = useChanges.getState();
  store.toggleDir("s1", "docs");
  store.expandToPath("s1", "src/ui/deep/a.ts");
  const expanded = useChanges.getState().expandedDirs.s1;
  expect(expanded).toEqual({
    docs: true,
    src: true,
    "src/ui": true,
    "src/ui/deep": true,
  });
});

test("expandToPath on a root-level file changes nothing", () => {
  const before = useChanges.getState().expandedDirs;
  useChanges.getState().expandToPath("s1", "README.md");
  expect(useChanges.getState().expandedDirs).toBe(before);
});
