# Kriyon — domain glossary

A term must appear in the glossary before it becomes a module name, type name, or command name.
Keep Rust, the IPC bridge, and the frontend types using these words identically.

The glossary is split by area so you read only the part you need. This page is the index: it
names every term and the file that defines it. To add a term, put its entry in the right area
file and its name in the list below. `[Term]` in an entry refers to another glossary term.

## [Sessions, projects and worktrees](docs/context/sessions.md)

What a session is, where it runs, and how it is resumed, handed off and archived.

Session, Claude session id, Session title, Project (Workspace), Worktree, Session identity, Merge outcome, Preferred session view, Clear project, Inactive project, Past session, Follow-up session, Handoff link, Handoff file, Handoff card, Handoff prompt, Worktree bootstrap, Install command, Setup command, Branch collision, Archived session.

## [Terminals and the PTY daemon](docs/context/terminal.md)

The terminals Kriyon hosts and the daemon process that keeps each PTY alive.

Project terminal, Warm pane, Terminal tab, Terminal pane, Terminal workspace, Terminal dock, Terminal view, Link target, Raw view, Block, Engine, Write queue, Backpressure, Drained counter, PTY daemon, Run dir, Session socket, Daemon frame, Daemon client, Screen snapshot.

## [Changes view, files and git](docs/context/changes.md)

The git-derived Changes view, the file viewer and editor, and the file sandbox behind them.

Session diff, File diff, File change, Diff hunk, File kind, Visible files, Diff totals, Changes view, Transcript view, Session baseline, Git run, Working-tree budget, Command failure kind, Repo toplevel, Working-tree watch, Changes refresh coordinator, Changes view model, Touched files, Summary bar, Diff feed, File card, Jump rail, File tree pane, All-files browser, File viewer, File viewer notice, Code editor, File draft, File content, File sandbox, New-entry sandbox, Sandbox root, Save conflict guard, Details rail, Changed-files list, Highlighter.

## [Transcript and Claude's output](docs/context/transcript.md)

How Kriyon reads what Claude writes: the transcript file, structured events and the screen.

Studio event, Structured view, Work report, Partial reply, Spinner tip, CLI dialog, Structured event, Transcript schema, Drift report, Drift guard, Transcript, Clean copy, Task.

## [Composer and prompts](docs/context/composer.md)

Writing to Claude: the composer, attachments, prompt history and saved prompts.

Attachment, Pasted image, Attachment caution, Taken-back prompt, Prompt history, Sent prompt, Saved prompt, Prompt picker, Placeholder, Promote, Composer draft, Prompt library view, Prompt row actions.

## [Hooks, Companion and activity](docs/context/integration.md)

How Claude Code tells Kriyon what it is doing: hooks, the Companion bridge and the activity log.

Status, Hooks off, Integration, Integration prefs, Hook route, Companion folder, Kriyon Companion, Companion bridge, Owning claude, Bridge spool, Companion state, Hook spool, Activity log, Activity step, Step flags, Activity store, Activity tab, Step detail, Spool cursor, Seed lines, Refusal watch, Redaction, Managed source, Managed policy, Side-loading, Hook signal.

## [Session activity, Needs-you and notifications](docs/context/activity.md)

What a session is doing right now, when it needs the user, and how Kriyon tells them.

Session engagement, Subagent, Background shell, Main turn, Waiting for, In-flight work, Background agent, Session activity, Session activity projection, Main agent, Tool activity, Current tool, Agent id / Agent type, Settle, Command center, Session standing, Standing state, Needs-you rail, Pending ask, Viewed marker, Needs-you section, Needs-you overlay, Standing staleness, Session heartbeat, Notify preference, Notify sound, Notification kind, Notification content, Notification plan, Settle window, Pty-quiet confirm, Task progress, Task strip.

## [App runtime, resources and usage](docs/context/runtime.md)

Boot, the per-session runtime, memory and process limits, usage numbers, stopping processes, and updates.

Boot phase, Main session lock, Session runtime, Watch route, Event subscription helper, Status-line, Usage snapshot, Plan limits, Limit reading, Session footprint, Memory budget, Session resources, Resource sweep, Process tree, Sleeping session, Sleep ledger, Usage card, Plan limits view, Session usage view, Tree stop, Surveyor, Process survey, Stop target, Signal gate, Handover, Quit intent, Daemon adoption, Orphan daemon, Detached lease, Stop cost, SWR resource, AppKit exception guard, Update channel, Update feed, Channel step-down, Skipped version.

## [App shell and look](docs/context/ui.md)

The window chrome, menus, themes and the WebKit guards that keep the UI responsive.

Stray caret, DOM weight, Collapsible section, Mascot, Wordmark, Nav row, Anchored menu, Header action, Sort menu, Palette menu, Project menu, Confirm dialog, Theme, Theme registry, Steel, Style recipe, Accent.
