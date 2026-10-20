# ADR 0021 — File-tree entries: canonical parent / validated leaf, and delete-to-Trash

**Status:** accepted · 2026-08-30

**Relates to:** [File sandbox], [New-entry sandbox], [Sandbox root] (CONTEXT.md);
`docs/superpowers/specs/2026-08-30-file-tree-mutations-design.md`; ADR-0006
(string-typed IPC error seam); ADR-0017 (Working-tree budget)

## Context

The [All-files browser]'s context menu (New File, New Folder, Rename, Delete) needed
four Rust commands, and every one of them breaks an assumption the sandbox had held
since it existed: `SandboxRoot::resolve` proves containment by **canonicalizing** the
joined path, and `canonicalize` fails on anything that is not already on disk. A create
target does not exist yet by definition. A rename's destination does not exist yet
either. That leaves nowhere to hang "is `src/new.ts` inside the root" for the one
operation whose entire job is to bring `src/new.ts` into existence.

The cost of getting this family of problem wrong was not theoretical. Just over an hour
before this feature's spec was written, the same-day security review of
`discard_file_changes` (commit `a94a489`, "derive the git pathspec from the resolved
path, not the raw request") found **two** data-loss bugs in one command, both from the
identical root cause: the sandbox validated one spelling of a path and handed a
*different* spelling to git.

- **Wildmatch widening.** `discard_file_changes` passed the raw `path` after `--` as a
  git pathspec, which is wildmatched. `app/[slug]/page.tsx` — how every Next.js repo
  spells a dynamic route — is a character class that also matches `app/s/page.tsx`, so
  restoring the first silently discarded the uncommitted content of the second. A file
  literally named `*` took the whole repo with it.
- **Canonical vs. lexical divergence.** `SandboxRoot::resolve` settles containment on the
  *canonical* path (symlinks and `..` resolved by the filesystem); git resolves `..`
  *lexically* (text substitution, no filesystem involved). A symlink to a directory
  deeper inside the root made the two disagree in the escaping direction:
  `short/../../f` could canonicalize to a location inside the root while the lexical
  spelling git actually walked pointed one level above it.

Both closed the same way — hand git the *resolved* path, relative to the root, never the
raw request — and neither bug had failed the test suite beforehand, because the tests
that existed returned inside `resolve()` and never reached the git call that diverged
from it. That is the standing evidence for this ADR's first rule: **containment is
whatever the canonical filesystem path says it is, checked once, and every downstream
consumer acts on that resolved value — never on a second, independently-derived spelling
of the same request.**

## Decision 1 — canonicalize the parent, validate the leaf; never lexical path math

`SandboxRoot::resolve_new(path, verb) -> Result<NewSandboxedPath, String>` (`sandbox.rs`):

- Split `path` into parent + final segment on the last `/` (an empty parent means the
  root itself).
- Resolve the **parent** through the existing, unchanged `SandboxRoot::resolve` —
  canonicalized, `.git`-refused, componentwise-contained. This is the only place
  containment is decided.
- Validate the **leaf** on its own, as a name rather than a path: non-empty; not `.` or
  `..`; contains no `/`, `\`, or NUL; is not `.git`; ≤ 255 bytes. A value passing this
  cannot traverse, so joining it onto an already-canonical, already-contained directory
  yields a path that is contained by construction — no second containment check needed
  on the joined result.
- Return `NewSandboxedPath`, not a bare `PathBuf`. Same discipline `SandboxedPath`
  already held: private fields, no public constructor, no `From`/`Deserialize`, so a
  path that skipped the split-and-validate is not a value any other module can hold, let
  alone hand to `git` or the filesystem.

Two Rust commands need exactly this (`create_file`, `create_dir`); a third
(`rename_entry`) needs it for its *target*. A fourth case surfaced only in review:
**`rename_entry`'s source and `delete_entry`'s target both already exist**, and the
initial implementation resolved them through plain `SandboxRoot::resolve` — the
whole-path canonicalizing rule. Two ways that was wrong, both caught before merge:

- `resolve` canonicalizes `.`/`""` straight to the sandbox root itself, and its
  containment check treats "equal to the root" as "inside the root". `delete_entry(root,
  ".")` therefore canonicalized to the project root and handed the *entire repository*
  to the Trash call in one shot.
- `resolve` follows a symlink through to its target. Renaming or deleting a symlink
  entry the user actually clicked would silently act on whatever it pointed at instead —
  moving or trashing a file the user never selected, and leaving the link itself
  (dangling, or now pointing at a relocated file) sitting in the tree.

Both close the same way decision 1 already established: split parent from leaf, resolve
the parent canonically, validate the leaf. `SandboxRoot::resolve_existing(path, verb)`
is that: it calls `resolve_new` (same split, same containment, same leaf rule — so `"."`
and `".."` are refused as names *structurally*, not by a special case bolted onto this
one caller) and additionally confirms something is actually there
(`NewSandboxedPath::exists`, via `symlink_metadata` so a symlink counts as "there"
without ever being followed). It returns the same `NewSandboxedPath` `resolve_new` does
— "new" names the shape the type proves, a validated parent plus a non-traversing leaf,
not a claim about whether the leaf exists — because a second newtype whose only
difference is "the leaf is confirmed present" would duplicate `NewSandboxedPath` rather
than add a distinct guarantee.

## Decision 2 — delete moves the entry to the Trash; a Trash failure is an error, never a silent permanent delete

`delete_entry` calls `NSFileManager.trashItemAtURL:resultingItemURL:error:`, not
`std::fs::remove_file` / `std::fs::remove_dir_all`.

- **Why the Trash at all.** This tree has no undo, the Delete item sits one row below
  Rename in the same menu, and a directory delete is recursive — the blast radius of one
  misclick is unbounded and instant. Finder's Trash makes it recoverable (Put Back) for
  the cost of one Cocoa call, and it is one call for both files and directories — unlike
  `remove_file`/`remove_dir_all`, which are two different operations the caller has to
  pick correctly, `trashItemAtURL` does not care which it was handed.
- **Why a failure must not degrade.** The one property that makes the Trash worth
  choosing over a permanent delete — *this is recoverable* — is exactly the property a
  silent fallback would remove precisely when it matters most: if `trashItemAtURL` fails
  (permissions, a sandboxed-app entitlement gap, the Trash volume being full or
  unavailable), falling through to `remove_file`/`remove_dir_all` would perform the one
  action the whole design exists to avoid, under the one condition — an API failure the
  user cannot see coming — where they have the least reason to expect it. `trash()` maps
  the `NSError` straight to `Result::Err` via `?`; there is no other code path in
  `delete_entry_sync` that reaches `remove_file`/`remove_dir_all`, so there is nothing
  for a future edit to "fall through" to by accident.
- **The entry, not its target.** Reusing decision 1's `resolve_existing` here (rather
  than `resolve`) is what keeps a symlinked entry acting on the link: deleting a symlink
  removes the directory entry and leaves whatever it pointed at untouched, matching
  Finder and VS Code rather than following the link into the Trash and leaving a dangling
  reference behind.

## Consequences

- Every command in `entry_cmd.rs` — `create_file`, `create_dir`, `rename_entry`,
  `delete_entry` — resolves its target through one of exactly two `SandboxRoot` methods,
  both introduced by this ADR: `resolve_new` for a name that does not exist yet, and
  `resolve_existing` for an entry that does. Plain `resolve` stays where it was, serving
  the content commands in `file_cmd.rs`; no entry command reaches for it. None of the four
  can construct or receive a bare, unchecked `PathBuf` standing in for either type, so a
  future fifth command has no third option to invent.
- `entry_cmd.rs` holds no containment logic of its own; `sandbox.rs` is the only module
  that decides what "inside the root" means, for a path that exists, one that does not
  yet, or one already acted upon.
- A rename can only ever be same-directory: `new_name` is validated as a standalone leaf
  by the same rule `resolve_new` applies to its own leaf, so no spelling of it can name
  "somewhere else". A move is a different, larger operation and this feature does not
  offer it.
- Deleting a directory takes everything under it to the Trash in the same call macOS
  would use for a Finder drag — no separate recursive-walk code path in Kriyon to keep in
  sync with what `remove_dir_all` does.
- `resolve_existing`'s `exists()` check is check-then-act, not airtight — a name landing
  between the check and the `rename`/trash call is possible in principle. On a
  single-user desktop app the odds are low, and the failure mode is a clobbered rename
  target or a trash-of-something-else, never an escape past containment; closing the
  window entirely would need a filesystem transaction primitive Kriyon's targets don't
  offer.

## Alternatives rejected

- **Lexically normalize `..` and check containment without canonicalizing.** This is the
  exact divergence the `a94a489` review closed the same day, just over an hour before
  this feature's spec was written. Text-level path math and the filesystem do not always
  agree, and every case where they disagree runs in the escaping direction — a lexical
  rule looks safe on every input that does not have a symlink in it, which is precisely
  the input a review does not think to construct.
- **Create first, canonicalize the result, and unlink it if it landed outside the root.**
  Rejected for `resolve_new`: it writes to disk before deciding the caller is allowed to,
  and the check races anything else watching the directory — a `TOCTOU` window with a
  visible side effect on the losing side, not just a rejected `Result`.
- **Fall back to `remove_file`/`remove_dir_all` when `trashItemAtURL` fails**, so a
  delete "always succeeds". Rejected: the whole point of choosing the Trash was to make
  the operation recoverable, and a fallback that is silent by construction would spend
  that guarantee exactly when the user has no other warning that anything unusual
  happened.
- **A single `resolve_or_create` method covering both the new-entry and
  existing-entry cases**, keyed by a boolean or an enum. Rejected: the two cases return
  callers different guarantees (`NewSandboxedPath`'s leaf may or may not exist for
  `resolve_new`, is confirmed to exist for `resolve_existing`), and a shared entry point
  would need the caller to remember which mode it asked for rather than the type
  recording it. `resolve_existing` is instead built *from* `resolve_new` plus one
  `exists()` check, so the two stay one small function apart rather than one branch
  inside a larger one.
