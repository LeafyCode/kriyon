# Sessions, projects and worktrees

What a session is, where it runs, and how it is resumed, handed off and archived.

Part of the Kriyon glossary. The index and the naming rule are in [`CONTEXT.md`](../../CONTEXT.md).

- **Session** — one interactive `claude` run hosted in a PTY at a given cwd. Has a `SessionId`
  (a Kriyon-generated UUID that gates the hook via `KRIYON_SESSION` and names Kriyon's per-session
  files). Claude owns its own session id; Kriyon learns it (and the transcript path) from hook
  events. Also has a `SessionStatus`.
- **Claude session id** (`claudeSessionId`) — Claude Code's own session UUID, learned from the
  hook `session_id` field and persisted so the Session can be resumed with `claude --resume` on a
  later launch. Distinct from `SessionId` (Kriyon's launch id). _Avoid_: session id (ambiguous).
- **Session title** — the human label for a Session shown in the sidebar. Sourced from Claude's
  `ai-title` transcript line (it updates as the Session evolves); falls back to the cwd basename
  until the first title lands.
- **Project (Workspace)** — a git repository the user works in. Groups sessions in the sidebar.
- **Worktree** — a git worktree (a checked-out branch at its own path). A session runs in a
  project root or one of its worktrees — always the user's explicit choice, never a default.
  The sidebar marks a worktree session with its branch name and a yellow warning while its
  work isn't in the base branch yet ("Not committed", then "Not merged"), and each project
  header counts its open worktree sessions (ADR-0011).
- **Session identity** (`SessionIdentity`) — a [Session]'s display fields, resolved by the single
  pure join of a `SessionRow` with its `ProjectRow`: the project's display name (or its id when the
  project row is orphaned), the [Session title], and the branch (the worktree path basename, or none
  in the project root). The one place notification display and the [Session standing] snapshot derive
  a session's name from, so the fallbacks can't drift. _Avoid_: session display, session info.
- **Merge outcome** (`MergeOutcome`) — the result of merging a [Session]'s branch into the base
  checkout: `clean`, or `conflicted` with the conflicted file paths. Conflicts are surfaced
  read-only; the user resolves them in the [Raw view]. _Avoid_: merge result.
- **Preferred session view** (`preferredSessionView`) — the view a [Session] opens in and comes
  back to from the [Changes view]: the [Raw view] or the [Structured view], whichever the user last
  picked in the header (or on the welcome screen). A detour the user didn't choose — the terminal a
  permission prompt needs — doesn't change it. _Avoid_: default view.
- **Clear project** (`ClearProjectConfirm`) — closing every [Session] in a
  [Project (Workspace)] at once, behind a [Confirm dialog] and reported by a toast.
  Runs the same per-session close a row's own control uses ([Archived session]s included,
  since they are what would otherwise leave an empty group on the rail). The confirm
  snapshots the session ids it names and closes only those: a session that arrives while
  the modal is up never appeared in any confirm, so it survives. The project row itself
  survives in the store, so opening the folder again brings back its name, colour and
  [Past session]s — but a cleared project has no group on the rail, and therefore no
  History, until then. [Worktree]s are never removed. _Avoid_: delete project, remove
  project.
- **Inactive project** (`inactiveProjectIds`) — a [Project (Workspace)] whose every open
  [Session] has folded away under the sidebar's `hideOlderThan` threshold, so the whole
  group leaves the rail for one "N inactive projects" disclosure. The exemptions that keep
  a row visible (the active session, running/waiting/error work, an unread finish) each
  keep the group visible too, and a filter turns the fold off. _Avoid_: hidden project,
  stale project.
- **Past session** (`PastSession`) — a session discovered from a folder's
  on-disk Claude history (`~/.claude/projects/<encoded-cwd>/<id>.jsonl`) that
  Kriyon does not yet track. Carries the [Claude session id] (the file stem),
  a last-active time, and a summary (title, preview, cwd, branch). Ephemeral:
  shown in the sidebar's "Earlier sessions" group and never persisted until the
  user resumes it, at which point it becomes a normal [Session]. _Avoid_: old
  session, history entry.
- **Follow-up session** — a new [Session] spawned from an existing one, seeded with a
  [Handoff prompt] and optionally created in a fresh [Worktree]. The natural successor to
  Claude Code's `/handoff`. The [Handoff prompt] carries the continuity, so a follow-up is
  an ordinary [Session] once launched; it also records its predecessor as a [Handoff link].
  _Avoid_: child session (that's a [Subagent]), spawned session.
- **Handoff link** — the stored pointer (`parent_session_id`) from a [Follow-up session] to
  the [Session] it was spawned from, recorded for every follow-up. Shown as a "↓ from <title>"
  badge on the follow-up's sidebar row; clicking it selects the predecessor. Display only — it
  never moves context between the two. _Avoid_: parent session, session tree.
- **Handoff file** — the `*handoff*.md` file the user's own handoff skill (e.g. `/…:handoff`)
  writes. Kriyon spots it from hook events at zero token cost — a slash command whose name
  contains a handoff fragment, a `Write` of such a file, or a `Bash` command naming one in a
  temp dir that was modified during the turn — and, when that turn ends, offers it on a
  [Handoff card]. A file the session's own `Write` made may live in a temp dir or anywhere
  under the home folder outside its hidden folders; one a shell command names, or a search
  finds, must be in a temp dir. Validated in Rust (canonical, in an allowed place, a regular
  `.md` file under a size cap) before it reaches the UI. _Avoid_: handoff doc.
- **Handoff card** — the non-blocking "Handoff ready" card shown for a [Handoff file]: Open
  (the Spawn dialog, seeded with the file's [Handoff prompt]), Copy path, or Dismiss. Nothing
  is sent until the user confirms the dialog.
- **Handoff prompt** — the editable initial prompt seeded into a [Follow-up session],
  pre-filled from a deterministic, zero-token digest of the predecessor's recent work (files
  edited, commands run, [Task]s completed, the last assistant line) read straight off its
  [Studio event]s, and passed as the new session's first
  `claude` argument via a Kriyon-written, path-contained prompt file. Never
  keystroke-injected into a running Session. For a [Handoff file] it is the file's own
  starting-prompt section ("Next prompt", "Start with", …), else "Read <path> and continue.
  Focus: <the handoff command's arguments>", else "Read <path> and continue." — picked in Rust.
  _Avoid_: seed prompt, handoff doc.
- **Worktree bootstrap** — the one-time setup that makes a freshly created [Worktree]
  ready to work in: copying the project root's untracked top-level `.env*` files into it,
  running the [Install command] detected from the lockfile, then running the project's
  optional [Setup command]. Best-effort — a failed step warns but never blocks the
  Session from opening. _Avoid_: provisioning, worktree init.
- **Install command** — the dependency-install command a [Worktree bootstrap] infers from
  which lockfile is present (`pnpm-lock.yaml`→`pnpm install`, `package-lock.json`→`npm
  install`, `yarn.lock`→`yarn`, `bun.lockb`→`bun install`), or none. Purely a function of
  the present filenames. _Avoid_: package install.
- **Setup command** — an optional per-[Project (Workspace)] shell command, persisted on
  the project row, run once at the end of a [Worktree bootstrap] (e.g. `docker compose
  up -d`, a codegen step). The single escape hatch above the zero-config heuristics.
  _Avoid_: bootstrap script, hook.
- **Branch collision** — the condition where a new [Session] would start in a working
  directory a live (non-[Archived session]) [Session] already occupies — the same
  resolved repo path, hence the same branch. Surfaced as a spawn-time warning the user
  can override, never a persistent badge (the [Needs-you rail] restraint rule). _Avoid_:
  conflict (reserved for [Merge outcome]), clash.
- **Archived session** — a [Session] tidied out of the active sidebar and [Command
  center] with an `archivedAt` timestamp, typically after its branch merged cleanly. The
  Claude [Transcript] is preserved (so it remains discoverable as a [Past session]) and
  its [Worktree] is **not** removed unless the user explicitly asks. Reversible
  (un-archive). Shown in a collapsed "Archived" sidebar group. _Avoid_: deleted session,
  closed session.
- **Nested session** — a [Session] started from another one to do one piece of its work in
  parallel, and listed under it in the sidebar (`nested_under`). Claude starts one through the
  Companion's `start_session` tool. The person starts one with [Split off]. It is a real
  session with its own terminal, in its [Lead session]'s folder or on a new [Worktree], and its
  first answer is sent back to the lead session once. ADR-0049. _Avoid_: child session (that's
  a [Subagent]), sub-session, spawned session.
- **Lead session** — the [Session] a [Nested session] was started from, and the one it reports
  to. _Avoid_: parent session, owner.
- **Session request** — one `start_session` call as Kriyon receives it: the task prompt, a
  title, whether to use a worktree (and its branch), and who wanted it (`user_asked` only when
  the person's own typed or Remote Control prompt started the turn and names a session, with
  no one else's words delivered since; otherwise `own_initiative`). Validated in the Rust core
  and kept once by its tool call id. _Avoid_: spawn request.
- **Session proposal** — a [Session request] Kriyon did not start: Claude's own idea, or one
  past the [Nested session cap]. Shown as a compact card under the lead session's header
  ("Suggested by Claude", or "You asked · starts when a busy session finishes"), with the task
  folded to one line, Start session and Not now. One the person asked for starts by itself
  when a slot frees; Claude's own idea waits for a click. In memory only. _Avoid_: suggestion
  card, pending session.
- **Nested session cap** — the most other sessions that may be busy (working, waiting on the
  person, or still starting) before a requested session becomes a [Session proposal] instead of
  starting (Settings: a number from 1 to 16, default 4, or no limit). The session that asked is
  not counted: it is always mid-turn when it asks. A session counts from the moment Kriyon
  starts it, so requests arriving together count each other. _Avoid_: concurrency limit.
- **Split off** — the sidebar menu action that starts a [Nested session] by hand from the
  [Spawn dialog], with an empty task. _Avoid_: fork, branch off.
