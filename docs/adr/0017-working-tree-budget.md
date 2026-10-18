# ADR 0017 — The Changes view refuses a working tree it cannot afford to read

**Status:** accepted · 2026-07-31

## Context

Opening a large repo in Kriyon 0.7.0 hung the app. Measured on the repo itself:

| | |
|---|---|
| Untracked files | 87,523 (`opt/` = 6.7 GB / 84k files, `vendor-sdk/` = 1 GB) — none gitignored |
| `.git/objects` | 2.2 GB, of which **2.06 GB / 62,684 loose objects written that day** |
| `.git/kriyon-scratch-index` | 16.9 MB, rewritten on every refresh |

Two paths in `git_cmd.rs` are unbounded in the size of the working tree, and both ran here:

1. **The [Session baseline] snapshot.** `actions.ts` fires `captureBaseline` on every new
   session → `snapshot_tree` → `git add -A`, which content-hashes every non-ignored file and
   writes each into `.git/objects`. There is no git flag that bounds it. That is where the 2 GB
   of loose objects came from, and `diff_session_changes` re-runs it on *every* refresh.
2. **The untracked pass of `diff_working_tree`.** `git status --porcelain=v1 -uall` yielded
   87,523 paths; the loop then read each one (measured: **83,796 files, 1.48 GB of text**),
   turned each into a synthetic all-added `FileDiff`, and shipped the lot over IPC to be
   flattened and syntax-tokenized in the webview.

The existing guards could not see this. `UNTRACKED_MAX_BYTES` (1 MB) is **per file** — it caps
one large log and is blind to 84,000 small ones. The only aggregate guard was the Home-cwd skip
in `actions.ts`, added for the dotfiles-repo case; a huge non-home repo had nothing.

## Decision

**A [Working-tree budget] gates both paths, and an over-budget tree is refused rather than
computed.**

- `MAX_UNTRACKED_FILES = 10_000` — the ceiling. Over it, `snapshot_tree` returns a tagged error
  *before spawning `git add`*, and `diff_working_tree` skips its untracked pass.
- `MAX_UNTRACKED_BYTES = 8_000_000` — total untracked content one `SessionDiff` may carry. This
  is what actually bounds the IPC payload; the per-file cap bounds a single card.
- `MAX_SNAPSHOT_BYTES = 256 MB` — total untracked bytes `snapshot_tree` will let `git add -A`
  hash into `.git/objects`. A count ceiling alone is not a byte ceiling: 9,999 untracked files of
  999 KB each sit inside `MAX_UNTRACKED_FILES` and still ask git to hash ~10 GB, which is the
  original freeze arriving *within* budget. Enforced by summing `symlink_metadata` over the paths
  the gate already enumerated — bounded by the file ceiling, so microseconds on a healthy tree.

Four choices inside that, each load-bearing:

**The enumeration streams and stops early.** `untracked_paths_bounded` spawns
`git ls-files --others --exclude-standard -z` and reads its pipe incrementally, killing the child
once the count passes the ceiling. A pathological tree is never fully walked (measured: ~390 ms
to bail versus ~910 ms to enumerate all 87,523). `output()` would have waited for the whole
thing and defeated the exercise.

> **Streaming a subprocess means draining every pipe concurrently.** The first cut of this read
> stdout to EOF and only then read stderr, on the assumption that `ls-files` writes "at most an
> error line". It does not: git emits one `warning: could not open directory 'x/'` per unreadable
> directory, measured at ~60 bytes each. Past macOS's 64 KB pipe buffer — about **1,100 such
> directories** — git blocks writing stderr, never closes stdout, and the read loop waits forever:
> a permanently wedged blocking-pool thread, which is the same failure this ADR exists to prevent.
> Caught in review by reproducing it (the regression test hangs 30 s and fails without the fix).
> stderr is now drained on its own thread. Any future streamed spawn here must do the same.

**It replaced `git status -uall` rather than joining it.** Same set of paths, but `ls-files` is
plumbing: it does not refresh and re-write the repo's real index the way `status` does, and `-z`
emits raw path bytes instead of the C-quoted, octal-escaped form. That retired
`parse_untracked_paths`/`unquote_git_path` — 75 lines of escape decoding whose only reason to
exist was the textual protocol — in favour of a four-line `parse_nul_paths`. Cost is unchanged
on a healthy repo (78 ms vs 76 ms on this one), so the happy path pays nothing for the ceiling.

**Refusal is a reported state, not an error.** `SessionDiff.budgetExceeded` names the count, the
limit, and the wholly-untracked directories `git ls-files --directory` collapses the tree into
(156 ms and 8 entries on the repo above, against 910 ms and 87,523). Tracked changes are still
diffed and shown — they are bounded by the index, and they are the half a user reviews. The view
says which directory to gitignore, because that is the entire fix; "87,523 untracked files" is a
dead end.

**Filesystem-driven refreshes stop once the answer is known.** An over-budget repo is precisely
the one whose un-ignored directory something keeps writing into, so `fs-change`/`live-edit` would
fire indefinitely, each costing another enumeration to reach the same refusal. `requestRefresh`
suppresses those two reasons while `budgetExceeded` is set. User-driven reasons (`manual`,
`became-active`, `saved`, `baseline-landed`) still refresh — the refusal can only change when the
user gitignores something, so recovery stays one button away.

## Consequences

- A repo with over 10,000 untracked files shows tracked changes plus an explanation, and never
  writes a byte into `.git/objects` on Kriyon's behalf.
- `diff_working_tree` makes one fewer git spawn than before on every ordinary refresh.
- `snapshot_tree` makes one more (~78 ms on a healthy repo, on the async blocking pool, a few
  times a minute). Accepted deliberately over a cached verdict: a cache has a staleness window,
  and the event this exists to prevent — unpacking a multi-gigabyte SDK into the tree — is
  exactly the kind that lands inside one.
- `untracked_files` in a refusal is a **floor**, not a census; the whole point is that we stop
  counting. The UI says "more than 10,000", never a precise figure.
- Untracked content skipped for any reason is now counted into `omittedUntracked` and reported.
  It was silently dropped before, which let a review surface imply completeness it lacked.
- `WORKING_TREE_TOO_LARGE_PREFIX` joins `BASELINE_OBJECT_MISSING_PREFIX` as a hand-synced
  Rust↔JS string constant, with a contract-pin test on each side. Both degrade to
  `diff_working_tree`; only the baseline one clears the stored oid (see ADR 0015) — an
  over-budget tree says nothing about the baseline, which is still a valid object.

## Known limits

- **`untrackedDirs` is a sample, not a ranking.** It is a prefix of git's sorted `--directory`
  listing (scanning up to 1,000 entries), because ranking by size means walking the tree that was
  too big to walk. The UI says "Untracked directories include", never "mostly".
- **The read pass spends its byte budget in sort order.** `.cache/` and `build/` are alphabetically
  ahead of `src/`, so on a tree near the byte ceiling the files a user most wants to see are the
  ones most likely omitted. They are counted in `omittedUntracked`, not hidden, but the ordering
  is arbitrary rather than useful.
- **A refused `captureBaseline` is permanent for that session.** `actions.ts` swallows the
  rejection and nothing retries, so a session opened while over budget stays anchored to `HEAD`
  even after the user gitignores the directory. Retrying later would capture a baseline from the
  wrong moment, so this needs a deliberate design (record the refusal, offer an explicit capture)
  rather than a reflex retry.
- **Error classification still crosses the IPC seam as a string prefix.** `WORKING_TREE_TOO_LARGE_PREFIX`
  doubles down on the pattern `BASELINE_OBJECT_MISSING_PREFIX` established: both match against raw
  git stderr, which a repo-controlled hook or `core.fsmonitor` program could in principle spoof.
  A typed error over IPC would close both at once.

## Alternatives rejected

- **Bound `git add -A`.** No such flag exists. Reconstructing it as `git add -u` plus an explicit
  bounded untracked pathspec would work and would make the enumeration pay for itself, but it
  rewrites the most load-bearing function in ADR 0015's model for a saving of ~78 ms.
- **Detect after the fact from the scratch index size.** The first pathological snapshot still
  runs — and that first run is the reported bug.
- **Just gitignore it / tell the user.** Kriyon does not own other people's repos, and an app
  that hangs on a legal repository shape is a Kriyon bug regardless of what the repo contains.
