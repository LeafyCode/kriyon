import { beforeEach, describe, expect, it } from "vitest";
import type { DiffLine, FileDiff, SessionDiff } from "../types.ts";
import { type EditState, type SessionChanges, useChanges } from "./changes.ts";
import {
  aiFilterApplies,
  type ChangesViewInput,
  type ChangesViewState,
  changedFileCount,
  changesView,
  computeChangesView,
  cwdRelativePath,
  forgetChangesView,
  treeDecorations,
} from "./changesView.ts";

function line(kind: DiffLine["kind"], text: string): DiffLine {
  return { kind, text };
}

/** A file with `additions` added and `deletions` removed lines, so a test can
 * state the ± totals it expects rather than counting hunk lines by hand. */
function file(
  path: string,
  additions = 1,
  deletions = 0,
  overrides: Partial<FileDiff> = {}
): FileDiff {
  return {
    binary: false,
    hunks: [
      {
        header: "@@ -1,1 +1,1 @@",
        lines: [
          ...Array.from({ length: additions }, () => line("added", "+")),
          ...Array.from({ length: deletions }, () => line("removed", "-")),
          line("context", " "),
        ],
      },
    ],
    oldPath: null,
    path,
    status: "modified",
    ...overrides,
  };
}

/** A `modified` file with no hunks — the true zero-change noise
 * `visibleFiles` filters out before anything renders it. */
function noiseFile(path: string): FileDiff {
  return {
    binary: false,
    hunks: [],
    oldPath: null,
    path,
    status: "modified",
  };
}

function diff(
  files: FileDiff[],
  overrides: Partial<SessionDiff> = {}
): SessionDiff {
  return { base: "HEAD", files, ...overrides };
}

/** A `ready` entry whose `totals` are the honest whole-diff totals the
 * [Changes refresh coordinator] would have stored for `d`. */
function readyEntry(
  d: SessionDiff,
  overrides: Partial<SessionChanges> = {}
): SessionChanges {
  const visible = d.files.filter((f) => f.hunks.length > 0 || f.binary);
  let additions = 0;
  let deletions = 0;
  for (const f of visible) {
    for (const hunk of f.hunks) {
      for (const l of hunk.lines) {
        if (l.kind === "added") {
          additions += 1;
        } else if (l.kind === "removed") {
          deletions += 1;
        }
      }
    }
  }
  return {
    baselineLabel: "HEAD · uncommitted",
    collapsed: {},
    diff: d,
    fetchedAt: 1,
    hunkHashes: {},
    status: "ready",
    totals: { additions, deletions, files: visible.length },
    viewed: {},
    ...overrides,
  };
}

const NO_TOUCHED: Set<string> = new Set();

function input(overrides: Partial<ChangesViewInput> = {}): ChangesViewInput {
  return {
    cwd: "/repo",
    dirtyPath: undefined,
    drafts: undefined,
    entry: undefined,
    myEditsOnly: false,
    pendingJump: undefined,
    repoToplevel: "/repo",
    selectedFile: undefined,
    tab: "changes",
    touchedRelative: NO_TOUCHED,
    ...overrides,
  };
}

describe("computeChangesView — the pane matrix", () => {
  it("is loading before any fetch has ever landed for the session", () => {
    const view = computeChangesView(input());
    expect(view.pane).toBe("loading");
    expect(view.loadedOnce).toBe(false);
    expect(view.feedMounted).toBe(false);
  });

  it("is still loading while the first fetch is in flight", () => {
    const view = computeChangesView(
      input({
        entry: {
          baselineLabel: "",
          collapsed: {},
          diff: null,
          fetchedAt: 0,
          hunkHashes: {},
          status: "loading",
          totals: null,
          viewed: {},
        },
      })
    );
    expect(view.pane).toBe("loading");
  });

  it("is 'error' — not 'loading' — when the very first fetch is the one that failed", () => {
    const view = computeChangesView(
      input({
        entry: {
          baselineLabel: "",
          collapsed: {},
          diff: null,
          error: "not a git repository",
          fetchedAt: 0,
          hunkHashes: {},
          status: "error",
          totals: null,
          viewed: {},
        },
      })
    );
    expect(view.pane).toBe("error");
    expect(view.error).toBe("not a git repository");
  });

  it("keeps the previously loaded diff on screen behind an error banner", () => {
    const view = computeChangesView(
      input({
        entry: readyEntry(diff([file("src/a.ts")]), {
          error: "git exploded",
          status: "error",
        }),
      })
    );
    expect(view.pane).toBe("feed");
    expect(view.error).toBe("git exploded");
  });

  it("reports no error for a `ready` entry carrying a stale `error` string", () => {
    const view = computeChangesView(
      input({ entry: readyEntry(diff([file("src/a.ts")]), { error: "old" }) })
    );
    expect(view.error).toBeUndefined();
  });

  it("shows the feed once a diff with files has landed", () => {
    const view = computeChangesView(
      input({ entry: readyEntry(diff([file("src/a.ts")])) })
    );
    expect(view.pane).toBe("feed");
    expect(view.feedMounted).toBe(true);
    expect(view.loadedOnce).toBe(true);
  });

  it("shows an honest empty state, naming the baseline, for a loaded zero-file diff", () => {
    const view = computeChangesView(
      input({
        entry: readyEntry(diff([]), { baselineLabel: "main @ abc1234" }),
      })
    );
    expect(view.pane).toBe("empty");
    expect(view.emptyMessage).toBe("No changes vs main @ abc1234.");
    expect(view.feedMounted).toBe(false);
  });

  it("counts a zero-change noise file as no file at all", () => {
    const view = computeChangesView(
      input({ entry: readyEntry(diff([noiseFile("src/mode-only.ts")])) })
    );
    expect(view.files).toEqual([]);
    expect(view.pane).toBe("empty");
  });

  it("says 'budget', not 'empty', when an over-budget tree is why there is nothing to show", () => {
    const view = computeChangesView(
      input({
        entry: readyEntry(
          diff([], {
            budgetExceeded: {
              fileLimit: 10_000,
              untrackedDirs: ["opt/"],
              untrackedFiles: 10_268,
            },
          })
        ),
      })
    );
    expect(view.pane).toBe("budget");
  });

  it("still shows the feed for an over-budget tree that has tracked changes", () => {
    const view = computeChangesView(
      input({
        entry: readyEntry(
          diff([file("src/a.ts")], {
            budgetExceeded: {
              fileLimit: 10_000,
              untrackedDirs: ["opt/"],
              untrackedFiles: 10_268,
            },
          })
        ),
      })
    );
    expect(view.pane).toBe("feed");
  });

  it("shows the viewer whenever a file is open, on any tab", () => {
    const entry = readyEntry(diff([file("src/a.ts")]));
    for (const tab of ["all", "changes", "uncommitted"] as const) {
      expect(
        computeChangesView(input({ entry, selectedFile: "src/a.ts", tab })).pane
      ).toBe("viewer");
    }
    expect(computeChangesView(input({ entry, tab: "all" })).pane).toBe("feed");
  });

  it("keeps the feed mounted (display-toggled) while the viewer is showing", () => {
    const view = computeChangesView(
      input({
        entry: readyEntry(diff([file("src/a.ts")])),
        selectedFile: "src/a.ts",
        tab: "all",
      })
    );
    expect(view.pane).toBe("viewer");
    expect(view.feedMounted).toBe(true);
    expect(view.showViewer).toBe(true);
  });

  it("lets the viewer win over every notice, including before a diff has loaded", () => {
    // The all-files browser opens a file that isn't in the diff at all — the
    // loading/empty notices must not print underneath it.
    expect(
      computeChangesView(input({ selectedFile: "README.md", tab: "all" })).pane
    ).toBe("viewer");
    expect(
      computeChangesView(
        input({
          entry: readyEntry(diff([])),
          selectedFile: "README.md",
          tab: "all",
        })
      ).pane
    ).toBe("viewer");
  });

  it("resolves the selected file's diff row, or undefined when it isn't in the diff", () => {
    const a = file("src/a.ts");
    const entry = readyEntry(diff([a]));
    expect(
      computeChangesView(input({ entry, selectedFile: "src/a.ts", tab: "all" }))
        .selectedFileDiff
    ).toBe(a);
    expect(
      computeChangesView(
        input({ entry, selectedFile: "README.md", tab: "all" })
      ).selectedFileDiff
    ).toBeUndefined();
  });
});

describe("computeChangesView — the 'My edits only' filter", () => {
  const files = [file("a.ts"), file("b.ts"), file("c.ts")];
  const entry = readyEntry(diff(files));
  const touched: Set<string> = new Set(["a.ts"]);

  it("is stored but inert on the all-files tab, where its switch isn't rendered", () => {
    const view = computeChangesView(
      input({ entry, myEditsOnly: true, tab: "all", touchedRelative: touched })
    );
    expect(view.myEditsOnly).toBe(true);
    expect(view.editsFilterActive).toBe(false);
    expect(view.displayFiles).toBe(view.files);
  });

  it("narrows the display list to this session's touched files on the Changes tab", () => {
    const view = computeChangesView(
      input({ entry, myEditsOnly: true, touchedRelative: touched })
    );
    expect(view.editsFilterActive).toBe(true);
    expect(view.displayFiles.map((f) => f.path)).toEqual(["a.ts"]);
    expect(view.files).toHaveLength(3);
  });

  it("hands back the very same array when the filter is off, so nothing downstream re-renders", () => {
    const view = computeChangesView(input({ entry, touchedRelative: touched }));
    expect(view.displayFiles).toBe(view.files);
  });

  it("distinguishes 'the filter hid everything' from 'nothing changed'", () => {
    const view = computeChangesView(
      input({ entry, myEditsOnly: true, touchedRelative: NO_TOUCHED })
    );
    expect(view.pane).toBe("empty");
    expect(view.emptyMessage).toBe(
      "Claude hasn't changed any files in this session. Your own edits are under All changes."
    );
  });

  it("still names the baseline when the diff itself is empty and the filter is on", () => {
    const view = computeChangesView(
      input({ entry: readyEntry(diff([])), myEditsOnly: true })
    );
    expect(view.emptyMessage).toBe("No changes vs HEAD · uncommitted.");
  });

  it("neither filters nor shows its empty message on the all-files tab", () => {
    const view = computeChangesView(
      input({ entry, myEditsOnly: true, tab: "all" })
    );
    expect(view.pane).toBe("feed");
    expect(view.displayFiles).toHaveLength(3);
  });

  it("offers the switch only on the Changes tab, once a diff has loaded", () => {
    expect(computeChangesView(input({ entry })).showEditsToggle).toBe(true);
    expect(
      computeChangesView(input({ entry, tab: "all" })).showEditsToggle
    ).toBe(false);
    expect(computeChangesView(input()).showEditsToggle).toBe(false);
  });

  it("passes the whole visible list to the file viewer's lookup, filter or not", () => {
    // Toggling the filter must never hide a file already open in the viewer.
    const view = computeChangesView(
      input({
        entry,
        myEditsOnly: true,
        selectedFile: "b.ts",
        tab: "all",
        touchedRelative: touched,
      })
    );
    expect(view.selectedFileDiff?.path).toBe("b.ts");
  });
});

describe("computeChangesView — totals describe exactly what is on screen", () => {
  const files = [file("a.ts", 3, 1), file("b.ts", 5, 2), file("c.ts", 7, 4)];
  const entry = readyEntry(diff(files));
  const touched: Set<string> = new Set(["a.ts"]);

  it("reports the store's whole-diff totals with the filter off", () => {
    const view = computeChangesView(input({ entry, touchedRelative: touched }));
    expect(view.totals).toBe(entry.totals);
    expect(view.totals?.files).toBe(view.displayFiles.length);
  });

  it("recomputes the totals over the filtered subset once the filter bites", () => {
    const view = computeChangesView(
      input({ entry, myEditsOnly: true, touchedRelative: touched })
    );
    expect(view.totals).toEqual({ additions: 3, deletions: 1, files: 1 });
  });

  it("holds totals.files === displayFiles.length in every filter/tab combination", () => {
    for (const myEditsOnly of [false, true]) {
      for (const tab of ["all", "changes"] as const) {
        for (const touchedRelative of [NO_TOUCHED, touched]) {
          const view = computeChangesView(
            input({ entry, myEditsOnly, tab, touchedRelative })
          );
          expect(view.totals?.files).toBe(view.displayFiles.length);
        }
      }
    }
  });

  it("stays null before a diff has landed, rather than claiming a confident zero", () => {
    expect(computeChangesView(input()).totals).toBeNull();
  });

  it("reports a real zero once the filter hides every file", () => {
    const view = computeChangesView(
      input({ entry, myEditsOnly: true, touchedRelative: NO_TOUCHED })
    );
    expect(view.totals).toEqual({ additions: 0, deletions: 0, files: 0 });
  });
});

describe("computeChangesView — the Changes tab's unsaved-changes dots", () => {
  const entry = readyEntry(diff([file("app/src/a.ts"), file("app/src/b.ts")]));

  function draft(): EditState {
    return {
      baseline: "x",
      draft: "y",
      eol: "lf",
      sig: { len: 1, mtime: 1 },
    };
  }

  it("marks nothing when no file is dirty and nothing is stashed", () => {
    expect(computeChangesView(input({ entry })).dirtyPaths.size).toBe(0);
  });

  it("translates the live editor's cwd-relative path onto the diff's toplevel-relative row", () => {
    const view = computeChangesView(
      input({ cwd: "/repo/app", dirtyPath: "src/a.ts", entry })
    );
    expect([...view.dirtyPaths]).toEqual(["app/src/a.ts"]);
  });

  it("marks a stashed draft's row too, not just the live editor's", () => {
    const view = computeChangesView(
      input({ cwd: "/repo/app", drafts: { "src/b.ts": draft() }, entry })
    );
    expect([...view.dirtyPaths]).toEqual(["app/src/b.ts"]);
  });

  it("only ever marks rows that are actually on screen", () => {
    const view = computeChangesView(
      input({
        cwd: "/repo/app",
        dirtyPath: "src/b.ts",
        entry,
        myEditsOnly: true,
        touchedRelative: new Set(["app/src/a.ts"]),
      })
    );
    expect(view.dirtyPaths.size).toBe(0);
  });
});

describe("changesView — memoized per session on its actual inputs", () => {
  const files = [file("a.ts"), file("b.ts")];
  const entry = readyEntry(diff(files));

  function state(overrides: Partial<ChangesViewState> = {}): ChangesViewState {
    return {
      bySession: { s1: entry },
      dirtyFiles: {},
      fileDrafts: {},
      ui: {},
      ...overrides,
    };
  }

  const deps = {
    cwd: "/repo",
    repoToplevel: "/repo",
    touchedRelative: NO_TOUCHED,
  };

  beforeEach(() => {
    forgetChangesView("s1");
    forgetChangesView("s2");
  });

  it("hands back the identical object for unchanged inputs", () => {
    const s = state();
    expect(changesView(s, "s1", deps)).toBe(changesView(s, "s1", deps));
  });

  it("survives a scroll-shaped store tick without churning", () => {
    // `setActiveFile`/`markViewed` fire as the feed scrolls. Neither is an
    // input to this view, so the selector must return the same object and
    // leave every consumer of it unrendered.
    const first = changesView(state(), "s1", deps);
    const scrolled = state({
      bySession: { s1: { ...entry, viewed: { "a.ts": true } } },
    });
    expect(changesView(scrolled, "s1", deps)).toBe(first);
  });

  it("does not churn when another session's entry changes", () => {
    const first = changesView(state(), "s1", deps);
    const other = state({
      bySession: { s1: entry, s2: readyEntry(diff([file("z.ts")])) },
    });
    expect(changesView(other, "s1", deps)).toBe(first);
  });

  it("recomputes when the diff actually lands again", () => {
    const first = changesView(state(), "s1", deps);
    const refreshed = state({
      bySession: { s1: readyEntry(diff([file("a.ts"), file("c.ts")])) },
    });
    expect(changesView(refreshed, "s1", deps)).not.toBe(first);
  });

  it("recomputes on each UI input it actually reads", () => {
    const first = changesView(state(), "s1", deps);
    for (const ui of [
      { tab: "all" } as const,
      { selectedFile: "a.ts" },
      { myEditsOnly: true },
      { pendingJump: "a.ts" },
    ]) {
      expect(changesView(state({ ui: { s1: ui } }), "s1", deps)).not.toBe(
        first
      );
    }
    expect(
      changesView(state({ dirtyFiles: { s1: "a.ts" } }), "s1", deps)
    ).not.toBe(first);
  });

  it("recomputes when the touched-file set changes", () => {
    const first = changesView(state(), "s1", deps);
    expect(
      changesView(state(), "s1", {
        ...deps,
        touchedRelative: new Set(["a.ts"]),
      })
    ).not.toBe(first);
  });

  it("keeps one memo per session", () => {
    const s = state({ bySession: { s1: entry, s2: readyEntry(diff([])) } });
    const one = changesView(s, "s1", deps);
    const two = changesView(s, "s2", deps);
    expect(two).not.toBe(one);
    expect(changesView(s, "s1", deps)).toBe(one);
  });

  it("forgets a session's memo, so a closed session's diff isn't retained", () => {
    const s = state();
    const first = changesView(s, "s1", deps);
    forgetChangesView("s1");
    expect(changesView(s, "s1", deps)).not.toBe(first);
  });

  it("reads the store's per-session defaults", () => {
    const view = changesView(state(), "s1", deps);
    expect(view.tab).toBe("changes");
    // AI changes keeps to Claude's files unless turned off (ADR 0050).
    expect(view.myEditsOnly).toBe(true);
    expect(view.selectedFile).toBeUndefined();
    expect(view.pendingJump).toBeUndefined();
  });

  it("keeps the file arrays' identity across a recompute of the same diff", () => {
    // `DiffFeed` reads a new `files`/`displayFiles` array as "a refresh
    // landed" and restores the virtualizer's scroll offset for it. A refresh
    // and the "My edits only" filter are the only two things allowed to hand
    // it a new array — so a memo miss driven by anything else (consuming a
    // pending jump, a dirty dot appearing) must still return the same arrays,
    // or it silently cancels an in-flight jump.
    const first = changesView(state(), "s1", deps);
    const jumped = changesView(
      state({ ui: { s1: { pendingJump: "a.ts" } } }),
      "s1",
      deps
    );
    expect(jumped).not.toBe(first);
    expect(jumped.files).toBe(first.files);
    expect(jumped.displayFiles).toBe(first.displayFiles);
  });

  it("holds that identity under the filter too, and only breaks it for a real refresh", () => {
    const touched: Set<string> = new Set(["a.ts"]);
    const filtered = state({ ui: { s1: { myEditsOnly: true } } });
    const first = changesView(filtered, "s1", {
      ...deps,
      touchedRelative: touched,
    });
    const jumped = changesView(
      state({ ui: { s1: { myEditsOnly: true, pendingJump: "a.ts" } } }),
      "s1",
      { ...deps, touchedRelative: touched }
    );
    expect(jumped.displayFiles).toBe(first.displayFiles);
    // A landed refresh is a new diff, and must produce new arrays.
    const refreshed = changesView(
      state({
        bySession: { s1: readyEntry(diff([file("a.ts"), file("b.ts")])) },
        ui: { s1: { myEditsOnly: true } },
      }),
      "s1",
      { ...deps, touchedRelative: touched }
    );
    expect(refreshed.files).not.toBe(first.files);
    expect(refreshed.displayFiles).not.toBe(first.displayFiles);
  });

  it("churn parity, against the real store: scrolling the feed never invalidates it", () => {
    // The two writes a scroll actually makes, dispatched through the real
    // store rather than a hand-built snapshot — `setActiveFile` on every card
    // boundary crossed and `markViewed` on every card that comes into view.
    // Both must leave this view byte-for-byte the same object, or the whole
    // Changes subtree re-renders per scrolled-past file.
    useChanges.setState({
      activeFile: {},
      bySession: { s1: entry },
      dirtyFiles: {},
      expandedDirs: {},
      fileDrafts: {},
      ui: {},
    });
    const first = changesView(useChanges.getState(), "s1", deps);

    useChanges.getState().setActiveFile("s1", "b.ts");
    useChanges.getState().markViewed("s1", "a.ts");

    expect(changesView(useChanges.getState(), "s1", deps)).toBe(first);
    // …and the writes really landed, so this isn't passing on a no-op.
    expect(useChanges.getState().activeFile.s1).toBe("b.ts");
    expect(useChanges.getState().bySession.s1?.viewed["a.ts"]).toBe(true);
  });
});

describe("cwdRelativePath", () => {
  it("is a no-op when the toplevel is unknown or equals the cwd", () => {
    expect(cwdRelativePath("src/a.ts", "", "/repo")).toBe("src/a.ts");
    expect(cwdRelativePath("src/a.ts", "/repo", "/repo")).toBe("src/a.ts");
    // A trailing slash on either side must not make them look different.
    expect(cwdRelativePath("src/a.ts", "/repo/", "/repo")).toBe("src/a.ts");
  });

  it("walks up for a file outside the session cwd rather than pretending it is inside", () => {
    // Best-effort and deliberately honest: the backend sandbox refuses a
    // path that leaves `cwd`, and FileViewer's existing error banner says
    // so. Silently opening the wrong file would be worse.
    expect(cwdRelativePath("other/y.ts", "/repo", "/repo/app")).toBe(
      "../other/y.ts"
    );
    expect(cwdRelativePath("other/y.ts", "/repo", "/repo/a/b")).toBe(
      "../../other/y.ts"
    );
  });

  it("translates a file inside the session cwd", () => {
    expect(cwdRelativePath("app/src/a.ts", "/repo", "/repo/app")).toBe(
      "src/a.ts"
    );
  });

  it("sees through macOS's /private firmlinks, in both directions", () => {
    // git's `rev-parse --show-toplevel` canonicalizes; the session cwd is the
    // raw path the user (or the project row) gave. On a Mac the same
    // directory is spelled `/tmp/x` and `/private/tmp/x`, and neither
    // `startsWith` check matched — so Edit silently fell through to the
    // repo-relative path and opened "path does not exist".
    expect(
      cwdRelativePath("app/src/a.ts", "/private/tmp/r", "/tmp/r/app")
    ).toBe("src/a.ts");
    expect(
      cwdRelativePath("app/src/a.ts", "/tmp/r", "/private/tmp/r/app")
    ).toBe("src/a.ts");
    // `/var` (where macOS puts per-user temp dirs) and `/etc` are firmlinked
    // the same way.
    expect(cwdRelativePath("a.ts", "/private/var/f/r", "/var/f/r")).toBe(
      "a.ts"
    );
    expect(cwdRelativePath("other/y.ts", "/private/tmp/r", "/tmp/r/app")).toBe(
      "../other/y.ts"
    );
  });

  it("does not strip /private from a directory that is not firmlinked", () => {
    // `/private/mine` is a real directory, not a twin of `/mine` — collapsing
    // it would invent a relationship between two unrelated trees.
    expect(cwdRelativePath("app/a.ts", "/private/mine/r", "/mine/r/app")).toBe(
      "app/a.ts"
    );
  });

  it("leaves the path alone when the cwd is not under the toplevel at all", () => {
    // e.g. a symlinked worktree path the two backends spell differently —
    // there is nothing reliable to compute, so don't invent something.
    expect(cwdRelativePath("src/a.ts", "/repo", "/elsewhere")).toBe("src/a.ts");
  });
});

describe("changedFileCount — the number the Changes tab prints", () => {
  const files = [file("a.ts"), file("b.ts"), file("c.ts")];
  const entry = readyEntry(diff(files));

  function state(ui: ChangesViewState["ui"] = {}): ChangesViewState {
    return { bySession: { s1: entry }, dirtyFiles: {}, fileDrafts: {}, ui };
  }

  it("counts the whole diff when no filter is biting", () => {
    const off = { s1: { myEditsOnly: false } };
    expect(changedFileCount(state(off), "s1", NO_TOUCHED)).toBe(3);
  });

  it("counts what the feed shows once My edits only bites", () => {
    // The tab sits in the same header as the Summary bar. A tab reading
    // "Changes 3" over a bar reading "1 file" is the exact discrepancy the
    // [Changes view model] exists to prevent — it just wasn't reaching here.
    const touched = new Set(["b.ts"]);
    const ui = { s1: { myEditsOnly: true, tab: "changes" as const } };
    expect(changedFileCount(state(ui), "s1", touched)).toBe(1);
  });

  it("ignores the filter on the All-files tab, as the view model does", () => {
    const touched = new Set(["b.ts"]);
    const ui = { s1: { myEditsOnly: true, tab: "all" as const } };
    expect(changedFileCount(state(ui), "s1", touched)).toBe(3);
  });

  it("agrees with the view model's own totals in every case", () => {
    const touched = new Set(["b.ts"]);
    const cases: ChangesViewState["ui"][] = [
      {},
      { s1: { myEditsOnly: true, tab: "changes" } },
      { s1: { myEditsOnly: true, tab: "all" } },
      { s1: { myEditsOnly: false, tab: "changes" } },
    ];
    for (const ui of cases) {
      const s = state(ui);
      forgetChangesView("s1");
      const model = changesView(s, "s1", {
        cwd: "/repo",
        repoToplevel: "/repo",
        touchedRelative: touched,
      });
      expect(changedFileCount(s, "s1", touched)).toBe(model.totals?.files ?? 0);
    }
  });

  it("is 0 for a session with no diff yet", () => {
    const empty: ChangesViewState = {
      bySession: {},
      dirtyFiles: {},
      fileDrafts: {},
      ui: {},
    };
    expect(changedFileCount(empty, "s1", NO_TOUCHED)).toBe(0);
  });
});

describe("treeDecorations", () => {
  it("keys each changed file by its cwd-relative path and marks every folder above it", () => {
    const deco = treeDecorations(
      [
        file("src/a.ts"),
        file("src/ui/new.ts", 3, 0, { status: "added" }),
        file("README.md"),
      ],
      "/repo",
      "/repo"
    );
    expect(deco.files.get("src/a.ts")).toBe("modified");
    expect(deco.files.get("src/ui/new.ts")).toBe("added");
    expect(deco.files.get("README.md")).toBe("modified");
    expect([...deco.dirs].sort()).toEqual(["src", "src/ui"]);
  });

  it("translates toplevel paths when the session runs in a subfolder", () => {
    const deco = treeDecorations([file("app/src/a.ts")], "/repo", "/repo/app");
    expect(deco.files.get("src/a.ts")).toBe("modified");
    expect([...deco.dirs]).toEqual(["src"]);
  });

  it("drops changes outside the session's folder", () => {
    const deco = treeDecorations([file("other/a.ts")], "/repo", "/repo/app");
    expect(deco.files.size).toBe(0);
    expect(deco.dirs.size).toBe(0);
  });

  it("returns the same object for the same inputs", () => {
    const files = [file("src/a.ts")];
    expect(treeDecorations(files, "/r", "/r")).toBe(
      treeDecorations(files, "/r", "/r")
    );
  });
});

describe("the All changes scope", () => {
  const sessionFiles = [file("src/claude.ts")];
  const uncommittedFiles = [file("src/claude.ts"), file("src/mine.ts", 2, 1)];

  function allChanges(overrides: Partial<ChangesViewInput> = {}) {
    return computeChangesView(
      input({
        entry: readyEntry(diff(sessionFiles), {
          baselineLabel: "session start",
          uncommitted: {
            diff: diff(uncommittedFiles),
            label: "HEAD · uncommitted",
          },
        }),
        tab: "uncommitted",
        ...overrides,
      })
    );
  }

  it("lists every uncommitted file, not just the session's, with its own totals and label", () => {
    const view = allChanges();
    expect(view.displayFiles.map((f) => f.path)).toEqual([
      "src/claude.ts",
      "src/mine.ts",
    ]);
    expect(view.totals).toEqual({ additions: 3, deletions: 1, files: 2 });
    expect(view.baselineLabel).toBe("HEAD · uncommitted");
    expect(view.pane).toBe("feed");
    // The session's own list is untouched — the Inspector reads it.
    expect(view.files.map((f) => f.path)).toEqual(["src/claude.ts"]);
  });

  it("is loading until the uncommitted diff first lands", () => {
    const view = computeChangesView(
      input({ entry: readyEntry(diff(sessionFiles)), tab: "uncommitted" })
    );
    expect(view.pane).toBe("loading");
    expect(view.feedMounted).toBe(false);
  });

  it("ignores the only-Claude's-files filter, which belongs to AI changes", () => {
    const view = allChanges({ myEditsOnly: true });
    expect(view.editsFilterActive).toBe(false);
    expect(view.showEditsToggle).toBe(false);
    expect(view.displayFiles).toHaveLength(2);
  });

  it("says so plainly when nothing is uncommitted", () => {
    const view = computeChangesView(
      input({
        entry: readyEntry(diff(sessionFiles), {
          uncommitted: { diff: diff([]), label: "HEAD · uncommitted" },
        }),
        tab: "uncommitted",
      })
    );
    expect(view.pane).toBe("empty");
    expect(view.emptyMessage).toBe("No uncommitted changes.");
  });

  it("shows its own fetch error", () => {
    const view = allChanges({});
    const failed = computeChangesView(
      input({
        entry: readyEntry(diff(sessionFiles), {
          uncommitted: { diff: null, error: "git broke", label: "" },
        }),
        tab: "uncommitted",
      })
    );
    expect(view.error).toBeUndefined();
    expect(failed.error).toBe("git broke");
    expect(failed.pane).toBe("error");
  });

  it("colours the Files tree from uncommitted work once it is loaded", () => {
    const view = allChanges({ tab: "all" });
    expect([...view.decorations.files.keys()].sort()).toEqual([
      "src/claude.ts",
      "src/mine.ts",
    ]);
  });

  it("the AI changes tab keeps the session's own label", () => {
    const view = allChanges({ tab: "changes" });
    expect(view.baselineLabel).toBe("session start");
    expect(view.displayFiles.map((f) => f.path)).toEqual(["src/claude.ts"]);
  });
});

describe("AI changes keeps to Claude's files by default", () => {
  beforeEach(() => {
    forgetChangesView("s1");
    useChanges.setState({
      bySession: {},
      dirtyFiles: {},
      fileDrafts: {},
      ui: {},
    });
  });

  it("filters to the files Claude changed until the switch is turned off", () => {
    useChanges.setState({
      bySession: { s1: readyEntry(diff([file("claude.ts"), file("mine.ts")])) },
    });
    const deps = {
      cwd: "/repo",
      repoToplevel: "/repo",
      touchedRelative: new Set(["claude.ts"]),
    };

    const before = changesView(useChanges.getState(), "s1", deps);
    expect(before.myEditsOnly).toBe(true);
    expect(before.displayFiles.map((f) => f.path)).toEqual(["claude.ts"]);
    expect(
      changedFileCount(useChanges.getState(), "s1", deps.touchedRelative)
    ).toBe(1);

    useChanges.getState().toggleMyEditsOnly("s1");
    const after = changesView(useChanges.getState(), "s1", deps);
    expect(after.displayFiles).toHaveLength(2);
  });

  it("says Claude changed nothing, rather than nothing changed", () => {
    useChanges.setState({
      bySession: { s1: readyEntry(diff([file("mine.ts")])) },
    });
    const view = changesView(useChanges.getState(), "s1", {
      cwd: "/repo",
      repoToplevel: "/repo",
      touchedRelative: new Set(),
    });
    expect(view.pane).toBe("empty");
    expect(view.emptyMessage).toBe(
      "Claude hasn't changed any files in this session. Your own edits are under All changes."
    );
  });
});

describe("attribution that can't be known yet", () => {
  it("leaves AI changes unfiltered rather than claiming Claude changed nothing", () => {
    const view = computeChangesView(
      input({
        entry: readyEntry(diff([file("a.ts")])),
        touchedRelative: null,
      })
    );
    expect(view.editsFilterActive).toBe(false);
    expect(view.showEditsToggle).toBe(false);
    expect(view.displayFiles).toHaveLength(1);
    expect(
      changedFileCount(
        {
          bySession: { s1: readyEntry(diff([file("a.ts")])) },
          dirtyFiles: {},
          fileDrafts: {},
          ui: {},
        },
        "s1",
        null
      )
    ).toBe(1);
  });
});

describe("the open file in a session rooted in a subfolder", () => {
  it("finds its diff even though the two paths are spelled from different roots", () => {
    const view = computeChangesView(
      input({
        cwd: "/repo/app",
        entry: readyEntry(diff([file("app/src/a.ts")])),
        repoToplevel: "/repo",
        selectedFile: "src/a.ts",
      })
    );
    expect(view.selectedFileDiff?.path).toBe("app/src/a.ts");
  });
});

describe("aiFilterApplies", () => {
  it("applies only when on, on AI changes, with Claude's files known", () => {
    const known = new Set(["a.ts"]);
    expect(aiFilterApplies(true, "changes", known)).toBe(true);
    expect(aiFilterApplies(false, "changes", known)).toBe(false);
    expect(aiFilterApplies(true, "uncommitted", known)).toBe(false);
    expect(aiFilterApplies(true, "all", known)).toBe(false);
    expect(aiFilterApplies(true, "changes", null)).toBe(false);
  });
});
