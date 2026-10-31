# Changes view, files and git

The git-derived Changes view, the file viewer and editor, and the file sandbox behind them.

Part of the Kriyon glossary. The index and the naming rule are in [`CONTEXT.md`](../../CONTEXT.md).

- **Session diff** (`SessionDiff`) — one computed set of a [Session]'s changes: a list of
  [File diff]s, the `base` it was diffed against, and the short sha that base resolved to
  (`baseSha`), so a label can name the exact anchor. Produced by three commands over the one
  shape — `diff_worktree` (`<base>...HEAD`, committed work on a branch), `diff_working_tree`
  (uncommitted work vs a merge-base or `HEAD`), and `diff_session_changes` (vs the [Session
  baseline], what the [Changes view] uses whenever a baseline exists). Built by the tolerant
  `parse_diff`. _Avoid_: changeset.
- **File diff** (`FileDiff`) — one file's entry in a [Session diff]: its path, an optional
  `oldPath` (renames only), a [File change], a `binary` marker, and its [Diff hunk]s. Several
  real changes carry no hunks at all (binary, a pure rename, an added or deleted empty file) —
  [File kind] is the one place those are told apart from true zero-change noise.
- **File change** (`FileChange`) — how a file changed in a [File diff]:
  `added | modified | deleted | renamed`.
- **Diff hunk** (`DiffHunk`) — one `@@ … @@` region of a [File diff]: the hunk header plus its
  `DiffLine`s (reusing the [Structured event] model's `DiffLine`/`DiffKind`, in `transcript.rs`).
- **File kind** (`fileKind`) — a [File diff]'s display bucket: `binary | content | empty |
  rename`. The one place the hunkless-but-real cases are told apart from noise, so every
  surface renders and counts them the same way. _Avoid_: file type, file status (that's [File
  change]).
- **Visible files** (`visibleFiles`) — a [Session diff]'s files minus true zero-change noise (a
  `modified` file with no hunks and no `binary` marker — e.g. a mode-only flip git reports with
  nothing to show). The single filtered list every [Changes view] surface renders from, so a
  file's visibility and the header's file count can never disagree.
- **Diff totals** (`DiffTotals`, `computeTotals`) — files / additions / deletions across a
  [Session diff]'s [Visible files]. Computed frontend-side from the hunks already on hand, so
  the number in the [Summary bar] and the [Changed-files list] is literally the diff on screen
  and not a second `git` opinion. _Avoid_: diff stats, counts.
- **Changes view** — the transcript tab labelled **Files**, last in the header after the two
  session views (Structured · Session · Files): the [Session]'s own "what changed" surface, and
  its project files, laid out as [File tree pane] | [Diff feed] | [Jump rail] under a [Summary
  bar]. The code keeps the name `changes`; only the label says Files. Read-and-edit, never a gate: it shows what git says changed, and the [Raw
  view] stays the source of truth for the work itself. _Avoid_: diff view, review view (that's
  the Inspector's [Merge outcome] flow).
- **Transcript view** (`TranscriptView`) — which pane the center column is showing:
  `changes | raw`. One value, flipped by the header's underline tabs and by the palette. The
  tabs read **Session** (`raw`) and **Changes**; the stored values keep their original names.
  With only two values there is no view to remember: leaving Changes (`leaveChangesView`) always
  returns to the [Raw view]. A persisted `"studio"` — written by a build that still had the
  structured pane — degrades to `raw` rather than failing the layout parse. _Avoid_: tab,
  transcript tab. Distinct from `layout.view` (studio | focus | command | prompts | settings),
  which picks the whole shell layout and has nothing to do with this. That value keeps `studio`
  as its name while the [Nav row] the user clicks reads "Sessions".
- **Session baseline** (`baselineOid`, `capture_baseline`) — the git tree oid a [Session]'s
  [Changes view] diffs against: a hook-free snapshot of the working tree at session start
  (`git add -A` + `git write-tree` against a throwaway index, so no commit, no ref, no HEAD
  move — `snapshot_tree`), persisted on the session row. Scopes the diff to "since this session
  started", catches edits made by any means, and self-corrects when a file is reverted (ADR
  0015). Null for pre-feature, resumed, and default-cwd ("Home") sessions, and cleared when git
  housekeeping prunes the object — all of which degrade to the whole-working-tree
  `diff_working_tree` rather than erroring. _Avoid_: checkpoint, snapshot commit (nothing is
  committed).
- **Git run** (`GitRun`, `git_run.rs`) — one prepared `git -C <repo> …` invocation and the single
  way Kriyon spawns git. Owns what every caller would otherwise re-transcribe: stripping the
  ambient `GIT_DIR`/`GIT_WORK_TREE`/`GIT_INDEX_FILE` so `-C` stays authoritative, running with
  the [Shell PATH] once it is known so hooks find the person's tools, retrying a spawn
  that macOS refused under fork pressure (EAGAIN/ENOMEM), and mapping a non-zero exit to its
  stderr. Callers pick an *outcome shape* rather than reaching past it: `text`/`bytes` (buffered,
  non-zero is an error), `outcome` (non-zero is data — a conflicted merge is not a failure), and
  `stream_nul` (NUL-separated entries read incrementally with an early stop, for the
  [Working-tree budget]'s bounded enumeration). Every shape drains stdout and stderr
  concurrently — a streamed reader that drains only one deadlocks the moment git fills the other.
  _Avoid_: git helper, run_git (that is one shape, not the module).
- **Working-tree budget** (`budgetExceeded`, `BudgetExceeded`) — the ceiling on untracked
  content the [Session diff] pipeline will look at: at most `MAX_UNTRACKED_FILES` untracked
  paths, and at most `MAX_UNTRACKED_BYTES` of their content in one diff. A working tree over the
  file ceiling is *refused*, not computed — the [Session baseline] snapshot never runs `git add
  -A` on it, and the untracked pass of `diff_working_tree` is skipped — because both are
  unbounded in the size of the tree, and a repo with a huge un-ignored directory (a 6.7 GB
  toolchain, an unpacked SDK) turned that into gigabytes of git objects and a multi-gigabyte IPC
  payload. Tracked changes are still diffed and shown: they are bounded by the index. The
  refusal rides on [Session diff] as `budgetExceeded`, naming the count and the untracked
  directories responsible, so the [Changes view] can say which directory to gitignore instead of
  showing a raw error. Content skipped under the byte ceiling (or for being binary/oversize) is
  counted in `omittedUntracked` rather than silently dropped. _Avoid_: diff limit, file cap.
- **Command failure kind** (`FailureKind`, `tagged_failure`) — the four recoverable IPC failures
  the frontend reacts to by *kind* rather than by re-matching wording: `baselinePruned` (a pruned
  [Session baseline] object), `overBudget` (a [Working-tree budget] refusal), and `saveConflict` /
  `fileMissing` (a `write_file` save conflict, and a deleted-path failure `resolve_within` tags —
  shared by `write_file`, `read_file`, `list_dir`, and `git_cmd::read_baseline_sync` alike, so
  they all classify the same way). A fifth, `outsideRoots`, is `open_path` refusing a file outside every
  project: the frontend asks the user, and opens it with `allowOutside` only on their yes. Rust's `tagged_failure(kind, message)`
  (`crates/kriyon-core/src/failure.rs`) prepends a `"kind:<slug>: "` leader to the message each of
  the five error sites already produced (`overBudget` tags twice, at `snapshot_tree`'s file- and
  byte-ceiling refusals) — the human wording is unchanged, only tagged. `src/ipc/failures.ts`'s
  `commandFailure`/`failureMessage` are the one classifier/display-strip on the TS side; the
  four `is*Error` helpers (`isMissingBaselineObjectError`, `isWorkingTreeTooLargeError` in
  `state/changes.ts`, `isConflictError`, `isMissingFileError` in
  `changes/useFileEditorSession.ts`) are thin wrappers over `commandFailure`. Replaces four
  independently hand-rolled prefix/substring pairs (ADR-0006's addendum); every other IPC
  failure stays a plain, untagged string — the Rust↔JS seam is still `Result<T, String>`.
  _Avoid_: error code, error type (nothing but a `String` crosses the boundary; see ADR-0006).
- **Repo toplevel** (`repo_toplevel`) — a [Session]'s `git rev-parse --show-toplevel`, resolved
  once per cwd and cached, so [Touched files]' absolute paths can be relativized against the
  repo-relative paths a [Session diff] speaks in. Fails safe: a failed lookup stays claimed
  rather than retried, and a symlinked project path (the toplevel is a realpath, the touched
  path may not be) simply drops every badge instead of mis-attributing one. _Avoid_: repo root
  (ambiguous with the [Project (Workspace)] path a worktree session does *not* diff against).
- **Working-tree watch** (`tree_watch`, `working-tree-changed`) — one recursive `notify` watch
  per [Repo toplevel], refcounted across the [Session]s sharing that checkout, that re-runs the
  [Session diff] when files actually change. Covers what the hook-event stream cannot see: the
  user's own save, an external editor, `git checkout`/`stash`/`pull`, a build step, a subagent
  still mid-run. Ignores build/dependency trees and everything under `.git` except `HEAD` —
  computing the diff itself writes a scratch index and objects in there, so watching them would
  make every refresh schedule the next one. Bursts coalesce (debounce, with a max-wait so a
  continuous writer cannot starve the fire); the event names the repo, and the store maps it to
  the active session. _Avoid_: file watcher (ambiguous with the hook-events watch in
  `watcher.rs`), fs watch.
- **Changes refresh coordinator** (`state/changesRefresh.ts`, `requestRefresh`,
  `RefreshReason`) — the single owner of *when* a [Session diff] re-runs and against what.
  Every trigger — a completed mutating tool call, a [Working-tree watch] event, becoming
  active, a save, a landed [Session baseline], the manual button — arrives as one
  `requestRefresh(sessionId, reason)`, and only the reason varies the timing: `live-edit`
  settles behind a 500ms debounce so a burst of `MultiEdit` calls costs one diff, every
  other reason refreshes now. It also owns the bounds that keep triggers cheap — the
  active-session gate (an inactive session re-fetches when it is opened, never before), the
  [Working-tree budget] refusal gate over the two filesystem-driven reasons, and the
  memoized default-branch lookup — plus the [Repo toplevel] cache and the [Working-tree
  watch]'s registration and release. It owns the fetch too: the in-flight/trailing
  coalescing, the degrade ladder from a pruned [Session baseline] or an over-budget tree
  down to a working-tree diff, and the *refresh epoch* (`refreshEpoch`) — the timestamp of
  the last diff that actually landed, stamped on success and withheld on failure, which
  `useRevalidateOn(sessionId, fn)` turns into the one signal the [File editor] and the
  All-files tree revalidate off. The changes store holds that data and dispatches into the
  coordinator through its `refresh` action; it decides nothing about the fetch (ADR 0020).
  _Avoid_: refresh manager, diff scheduler.
- **Changes view model** (`state/changesView.ts`, `changesView(state, sessionId, deps)`) — the
  single resolved answer for what the [Changes view] renders for one [Session]: the [Visible
  files], the filtered display list, the [Diff totals] describing exactly that list, the
  unsaved-changes dots, and one `pane` (`feed | viewer | empty | budget | error | loading`)
  naming the one thing the diff column shows. The rules that relate those facts — a **My edits
  only** filter that only bites on the Changes tab, an empty state that must never contradict a
  [Working-tree budget] notice, a header whose totals must match the feed beneath it — live here
  as a pure function, not in a render body. Memoized per session on exactly the fields it reads,
  so the scroll-rate writes it ignores (`activeFile`, the [Jump rail]'s `viewed`) cost an O(1)
  cache hit and no re-render. _Avoid_: changes selector, view state.
- **Touched files** (`touchedFiles`, `sessionTouchedRelative`, `setTouchedFromActivity`,
  `sessionClaudeFiles`) — the files Claude changed in a [Session], as the [Activity log] records
  them (`activity_changed_paths`: finished edits and writes, subagents' included, the files a
  command changed — at most 20 per command — and edits from before a restart), which replaces
  the record on every refresh; the live stream's own additions only bridge the gap until then.
  `sessionClaudeFiles` is `null` while the answer can't be known. Per file, not per line, and attribution only: it never decides whether a change exists. It gives the "✎ this
  session" badge and backs **Only Claude's edits**, which is on by default in AI changes
  (ADR 0050, superseding ADR 0015's default-off). _Avoid_: edited files, session files.
- **Summary bar** — the [Changes view]'s one-line header strip: the [Diff totals] ("No changes"
  when there are none), what they are compared with in plain words (`comparedTo`: "since session
  start", "vs last commit", "vs main"), the AI changes tab's "Only Claude's edits" switch, and
  icon buttons for collapse, expand and refresh, with an "updated Xs ago" hint once stale. The
  exact baseline label sits in the comparison's tooltip. That label is the view's trust anchor and may never imply an anchor it can't name — `"HEAD · uncommitted"` for
  a base-less diff, `"<base> @ <shortSha>"` for a branch, and `"session start · snapshot
  <shortSha>"` for a [Session baseline] (deliberately not the `@ <sha>` commit shorthand, since
  a baseline oid names a tree). A refresh is non-disruptive: it never scrolls, collapses, or
  resets what the user is reading. _Avoid_: toolbar, stats bar.
- **Diff feed** — the [Changes view]'s center column: the virtualized, scrollable list of
  [File card]s, and the thing a jump request scrolls. _Avoid_: diff list, changes list.
- **File card** (`DiffFileCard`) — one [File diff]'s entry in the [Diff feed]: path, [File
  change] tag, ± counts, copy-path, the [Touched files] badge, and its [Diff hunk]s.
  Collapsible; collapses by default past a big-diff line threshold and for lockfile / minified
  / `dist` paths, with an explicit user toggle always winning over that default.
- **Jump rail** — the [Changes view]'s right-hand dot column, one dot per [Visible files] entry:
  click to scroll the [Diff feed] to that file, with the most-visible card marked active and a
  scrolled-past file marked `viewed`. A `viewed` flag survives a refresh unless that file's
  hunks actually changed, so refreshing never wipes the user's progress through a review.
  _Avoid_: minimap, scrollbar. Distinct from the [Viewed marker].
- **File tree pane** — the [Changes view]'s left column, three scope tabs: **AI changes** (the
  [Session diff]'s files Claude changed — the [Touched files] — grouped by directory; turning
  "Only Claude's edits" off shows everything since the session started), **All
  changes** (the [Uncommitted diff]'s files, laid out the same way) and **Files** (the
  [All-files browser]). All stay mounted across a flip. Clicking a changed file opens it in the [File viewer]
  beside the list, as an editor's git panel does (a deleted file, having nothing to open,
  scrolls the [Diff feed] to its card instead); the viewer covers the diff on every tab until
  it is closed.
- **Uncommitted diff** (`UncommittedChanges`, `SessionChanges.uncommitted`) — everything not yet
  committed (or, in a worktree, not yet on the default branch), whoever made it: what an
  editor's git panel shows, beside the [Session diff] rather than in place of it, so the
  Inspector and the header count keep meaning "this session". Fetched only while All changes or
  Files is showing (`scopeWantsUncommitted`); a session without a snapshot reuses its one diff.
  _Avoid_: working changes, git changes.
- **All-files browser** (`FileBrowserTree`, `list_dir`) — the lazy, directory-at-a-time tree of
  the whole repo under the [File tree pane]'s "All files" tab. Children are fetched on expand
  and never re-fetched behind a stale cwd. _Avoid_: file explorer, finder.
- **File search** (`FileSearch`, `rankFileMatches`, `list_files`) — the box at the top of the
  [All-files browser] that finds a file anywhere in the project by name, ranked so a match in
  the file's own name beats one in a folder above it. Reuses the `@`-mention walk, so it
  respects .gitignore and stops at 50 matches. While a query is typed its results replace the
  tree; opening one shows it in the [File viewer] and reveals it in the tree. _Avoid_: filter
  (it does not filter the tree), quick open.
- **Tree decorations** (`TreeDecorations`, `treeDecorations`) — the git marks the [All-files
  browser] paints: each changed file's kind of change, and which folders hold a change below
  them, translated from the diff's toplevel-relative paths into the tree's cwd-relative ones.
- **File viewer** — the whole-file pane the [Changes view] opens for a selected file. A text
  file is editable through the [Code editor]; a binary or truncated read is read-only and
  renders with a changed-line gutter marking what the current diff touched. Stays mounted and
  display-toggled across tab flips, so a draft, cursor, and scroll position survive. _Avoid_:
  preview pane.
- **File viewer notice** (`FileViewerNotice`, `useFileEditorSession`) — one banner the [File
  viewer]'s editing session raises over the file: a close or switch dirty guard, a failed save,
  the file having changed on disk, or the file having vanished from it. The hook derives them
  as an ordered list and `FileViewer` renders each with one switch, because only the two guard
  notices are mutually exclusive (a close outranks a pending switch, decided in one place) —
  the other three are independent facts and genuinely stack. Deliberately excludes the
  binary/truncated/lossy notices: those describe the *file*, not the session. _Avoid_: banner,
  error state, alert.
- **Code editor** (`CodeEditor`) — the hand-wrapped CodeMirror 6 instance the [File viewer]
  edits through, reached only via dynamic `import()` so CodeMirror never lands in the entry
  chunk, and themed from `src/theme/tokens.ts` like every other surface. An unknown or
  failed-to-load grammar degrades to a plain, still-editable editor — never a broken view (ADR
  0016). _Avoid_: editor (generic), IDE.
- **Session highlight** (`sessionHighlight`, `read_session_baseline`) — the [Code editor]'s
  faint accent tint on lines that differ from the file as it was when the session started (its
  [Session baseline] snapshot): what changed during this session, at line precision, whoever
  typed it. A file the session created is tinted whole. _Avoid_: AI blame (it does not know
  who typed a line, only when).
- **Blame note** (`blameAnnotation`, `blame_file`) — a quiet note at the end of the cursor's
  line: "Changed in this session", "Not committed yet", or the author, age and summary of the
  commit that last touched it. Hidden while the buffer has unsaved edits, since git's line
  numbers then no longer match.
- **Change peek** (`changePeek`, `revertChangeAt`) — clicking a git-gutter marker shows what the
  lines were in the last commit, with **Revert change** to put back just that change. An
  ordinary edit: the buffer turns dirty and ⌘Z undoes it. _Avoid_: discard hunk (nothing is
  written until Save).
- **File draft** (`EditState`, `stashFileDraft`/`takeFileDraft`) — one file's unsaved editor buffer:
  the `draft` text, the `baseline` it was read as, and the [Save conflict guard] signature that
  baseline was read at. Lives in the [File viewer] while it is mounted, and is stashed in the
  changes store when that pane leaves the [Warm pane] set — eviction is the one way a file closes
  without the user deciding to, so it must not be the one way a draft disappears. Taken back
  (once) on the next load of the same file. Only a dirty draft is stashed, and it keeps its
  original signature, so a file that moved on disk meanwhile still trips the [Save conflict guard]
  rather than silently overwriting. _Avoid_: buffer, autosave (nothing is written to disk).
- **File content** (`FileContent`, `read_file`) — one sandboxed file read for the [File
  viewer]: content, `size`, `mtime`, and `binary`/`truncated` markers (content past a 1 MB cap
  is dropped, never streamed wholesale over IPC). The `mtime` is half of the [Save conflict
  guard].
- **File sandbox** (`SandboxRoot::resolve`, `SandboxedPath`) — the containment rule every
  `read_file` / `list_dir` / `write_file` / `read_baseline` call passes: from a [Sandbox root],
  the frontend-supplied `path` is joined, canonicalized (resolving `..` and symlinks), and
  checked against that root *by path components*, never a string prefix. `read_file` /
  `write_file` / `read_baseline` then also refuse a path with a `.git` component; `list_dir`
  deliberately does not — it resolves via `resolve_for_listing` and skips `.git` entries by name
  while listing instead, which is the whole reason that second resolver exists and must not be
  folded into `resolve` (doing so would start refusing a call that succeeds today). The
  trust-boundary rule for file access, the same shape [Session socket] path containment already
  holds. Its result is a `SandboxedPath` either way, which no code outside `sandbox.rs` can
  construct, so "a path that skipped the check" is not a value the rest of the app can hold.
  A path that does not exist yet cannot go through `resolve` at all — that is the [New-entry
  sandbox]'s job. _Avoid_: path check, jail.
- **New-entry sandbox** (`SandboxRoot::resolve_new`, `SandboxRoot::resolve_existing`,
  `NewSandboxedPath`) — the [File sandbox]'s
  rule for a path that does not exist *yet*: the target of a create or a rename. The parent goes
  through `resolve` unchanged, so containment is still settled canonically, on a directory that
  really exists; only the final segment is new, and it is validated as a *name* — no separator,
  no `.`/`..`, no NUL, not `.git`, ≤255 bytes — so it cannot walk out of the parent that was just
  proven contained. Splitting is what makes it possible (`canonicalize` fails on a missing path);
  checking the parent canonically rather than normalizing the string lexically is what makes it
  safe. Its result is a `NewSandboxedPath`, a *different* type from `SandboxedPath` so that a
  command wanting an existing file cannot be handed a name that merely might become one.
  `resolve_existing` is the same split turned on an entry that *does* exist, so a rename or a
  delete acts on the directory entry rather than on whatever a symlink points at — and so the
  root itself, having no leaf, cannot be named at all. _Avoid_: create path, unchecked path.
- **Sandbox root** (`SandboxRoot`, `SandboxRoot::validate`) — a frontend-supplied `cwd` that has
  passed the whole IPC trust-boundary preamble: not flag-like, canonicalizes to a real directory
  inside a known session/project root, valid UTF-8. `validate` is its only constructor, and the
  seven store-taking commands take it as a *type* rather than re-running the preamble by hand, so
  skipping a check is a compile error rather than a code-review catch. Every [File sandbox]
  resolution starts from one. _Avoid_: cwd, repo path (those are the unvalidated strings it is
  built from).
- **Save conflict guard** (`write_file`, `FileWriteResult`) — the rule that a save is refused
  unless the target's on-disk `(mtime, len)` still matches what the [File viewer] last read, so
  a save can never silently clobber an edit `claude` made in the meantime. The write itself is
  atomic (temp file in the same directory, mode carried over, renamed over the target), and
  `.git/`, non-plain-file, oversized, and currently-binary targets are refused outright. On
  success the returned `(mtime, len)` becomes the expectation for the next save. _Avoid_:
  optimistic lock, dirty check (that's the editor's unsaved-text state).
- **Details rail** — the visible name of the Inspector: the right-hand column's 46px header
  reads "Details", and so does anything the user sees. The code keeps `Inspector` /
  `InspectorRail` / `INSPECTOR_WIDTH` throughout — one rename of ~40 files buys nothing, and
  the store field is persisted. Treat "Details" as the label and "Inspector" as the module.
  _Avoid_: details panel, info pane.
- **Changed-files list** (`ChangedFilesList`) — the Inspector's per-[Session] list of [Visible
  files] with their ± counts, inside a [Collapsible section] with the [Diff totals] pinned to
  the header. Selecting a row routes to the [Changes view] and jumps the [Diff feed] to that
  file. _Avoid_: file list (ambiguous with the [File tree pane]).
- **Highlighter** (`highlightLines`) — the lazy, singleton shiki tokenizer behind every
  syntax-colored read-only surface in the [Changes view] ([Diff hunk]s and read-only [File
  viewer] content), themed from `src/theme/tokens.ts` and reached only through dynamic
  `import()`. Never able to break a view: an unknown language, a failed grammar, or a failed
  init all degrade to plain lines rather than throwing — the same contract [Structured event]
  parsing holds. _Avoid_: syntax highlighter (generic), shiki (the library, not the term).
