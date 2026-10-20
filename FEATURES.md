# Kriyon — Feature List

_Current as of v0.9.0. Every entry here is shipped and reflected in `CHANGELOG.md`._

**What it is:** a Mac desktop app that wraps your own `claude` command-line tool in a nicer window. Every session is a real, fully-working terminal — the conversation itself stays exactly where it always was. Around it, Kriyon adds a diff view of what the session actually changed, a sidebar to juggle many sessions across projects, live status, notifications, and workflow helpers.

---

## Viewing a session

- **Real terminal per session** — a genuine terminal that runs `claude` and anything else (vim, ssh, REPLs, colors all work).
- **Click paths and links in Claude's output** — file paths and URLs are live in the terminal itself. Click a file to open it; Cmd-click to reveal it in Finder. Only known project and session folders open, and only safe file types.
- **Copy without broken line wraps** — copied text comes out as proper lines, not the mangled mid-line breaks terminals usually give; shows a "Copied — clean" confirmation.
- **Copy a single command's output** cleanly (tracks where each command starts and ends).
- **Message box (composer)** — type and send straight into the session; per-session drafts are remembered; can be hidden for a terminal-first style.
- **Type-ahead in the message box** — `/` lists Claude's real slash commands (built-in, your own, and plugin ones), `@` lists project files, folders, and agents while respecting `.gitignore`, and a leading `!` or `#` is recognised as a bash or memory shortcut. Picked suggestions become colored chips you can delete in one press.
- **The suggestion list stays quick** — it shows the best matches instead of every command you have installed, searches your project off the drawing thread, and floats above everything so an open terminal can never hide it.
- **Trackpad scrolling that feels right** — scrolls by actual finger distance; only mouse-wheel notches get amplified.
- **Smooth terminal scrolling** — a clean overlay scrollbar that fades in only while you scroll.
- **Snappy typing** — keystrokes go to the shell as raw bytes, with no round-trip in the way.

## Changes view

- **A Changes view beside the terminal** — flip any session between Session and Changes: a scrolling feed of syntax-highlighted diffs for every file the session touched, with a file tree beside it.
- **Each session shows its own work, not the whole repo** — Kriyon takes a private snapshot of the working tree when the session starts and diffs against it, so two sessions on the same checkout don't show the same pile of changes. Files that were already dirty before the session started stay out of the way.
- **Catches edits made by any means** — a `sed`, a formatter, a script; a change that gets reverted disappears again.
- **"✎ this session" badge** on files this session touched, plus a toggle to narrow the list to just those.
- **Summary bar** — file count and lines added/removed always in view, plus Collapse all / Expand all to turn a big review into an outline.
- **Jump rail** — a rail down the edge to hop between files and mark each one viewed.
- **Browse every file in the project** — an all-files tab opens the whole project tree and shows any file with its changed lines marked in the gutter.
- **Edit and save a file in place** — text files open in a real editor, not a viewer. Save with the usual chord (⌘S). Unsaved work follows you between files and survives its pane being closed, and if something else changed the file underneath you, Kriyon says so instead of overwriting.
- **Binary and non-UTF-8 files stay read-only** so a save can't corrupt them.
- **Real editing basics** — ⌘F find, ⌘G next, ⌥⌘F replace, ⌘D to select the next copy of your selection, alt-drag block selection, multiple cursors, and brackets that close themselves.
- **Change marks in the gutter** — lines added, changed, or deleted since the last commit are marked down the left edge, VS Code style. Untracked or unreadable files get no marks rather than wrong ones.
- **Windows line endings survive a save** — a CRLF file stays CRLF; a mixed file follows whichever ending it mostly uses.
- **Outside changes don't disturb you** — when Claude edits the file you have open, the reload keeps your cursor and scroll position and stays out of undo history. A file deleted on disk says so and offers to keep your draft.
- **Create, rename and delete from the file tree** — right-click for New File, New Folder, Rename and Delete with inline naming. Delete goes to Finder's Trash, so it's recoverable. The same menu has Open in Editor, Reveal in Finder, Copy Path and Copy Relative Path.
- **Discard a file's changes** — a button in the file viewer puts a file back to its last committed state. It only appears when it can actually do something.
- **Edit a file straight from its diff** — an Edit button on a diff card opens that file in the editor.
- **Unsaved work shows in the tree** — a dot marks any file with edits you haven't saved, including drafts for files you've since closed.
- **Open a file in your own editor** — the editor you use for code, not whatever the system picked for that file type.
- **The diff keeps up on its own** — as Claude edits, runs a command, or hands work to a subagent, the view refreshes, with a quiet marker rather than yanking the page while you read.
- **Jump straight to a change** — the Inspector lists changed files and clicking one scrolls the feed, and the sidebar row carries a count of the files a session has touched. Leaving and coming back puts you where you were.
- **Sandboxed** — reads and writes are limited to known project roots; symlinks can't disclose paths outside the repo, saves preserve file permissions and won't silently truncate.
- **A folder that isn't a git repo says so** plainly, instead of showing an error.
- **Stays smooth on big changes** — snapshots reuse a persistent scratch index inside the repo's own git directory (roughly five times faster, invisible to your working tree and hooks), and diff rows, the file tree, and highlights are memoized so a hundred-file view still scrolls.

## Juggling many sessions

- **Sidebar of projects and sessions** — sessions grouped under the folder/project they belong to.
- **Run many sessions at once** across different projects and branches.
- **Calm and Triage sidebar modes** — Calm keeps the list quiet; Triage floats active work up and folds read-Done sessions away.
- **Auto-named sessions** — each session uses Claude's own generated title, which updates as work evolves.
- **Rename a session** — double-click its title or pick Rename from its ⋯ menu. A name you choose sticks; Claude can't overwrite it in the background.
- **Rename a project** — double-click its header or use the pencil on hover. Enter keeps it, Escape backs out.
- **Drag projects into the order you want** — using the grip that appears on hover. The order survives restarts and holds in both Calm and Triage. Newly opened projects sit at the top until you place them.
- **Sort sessions** by date or name, or drag them into a manual order. The choice is global and any project can override it.
- **Fold away old sessions** — sessions past an age you pick collapse into a single "N older" line per project. The cutoff lives in the sort menu and survives a restart.
- **Search/filter the session list** by title or project.
- **One click, anywhere on the row** — the whole session row opens the session; newest sessions come first by default.
- **Reads as one column** — session titles line up with their project name, finished sessions sit flush with the rest, and the per-project count sits at the far edge. Sort, color, and new-session buttons appear over the count on hover instead of squeezing long names.
- **Start a new session** in any folder you pick.
- **Collapse/expand project groups**; each group shows a session count and an alert dot when one needs you.
- **Color-code your projects** (8 named colors or automatic).
- **Close a session** (cleanly shuts down its terminal and watchers) — with a confirm first if it holds an unsent message or unsaved file edits.
- **Clear a project** — "Close all sessions" in the project header's ⋯ menu, behind a two-step confirm. The project row, its name and colour stay.
- **Quiet projects fold away** — a project whose sessions have all gone stale collects into one "N inactive projects" row at the bottom of the rail, each showing how long it's been quiet, expandable in place.
- **Same-named projects tell themselves apart** — two folders both called `acme` show just enough of the path to separate them; unique names get nothing extra.
- **The focus rail goes to the session that wants you** — one waiting on you first, then one that's working, then the most recent.
- **Two layouts** — Sessions (full sidebar + Details rail) and Focus (a stripped-down project-rail layout).
- **Command palette (⌘K)** — search box to jump to any session or run any action.

## Knowing what needs you

- **Per-session status** — idle, running, waiting-for-input, done, or error, shown as a colored dot.
- **One-line progress summary** per session (e.g. "Editing foo.rs", "Waiting for your reply").
- **"Needs you" section** pinned at the top of the sidebar — gathers every session waiting on you, in error, or finished-but-unseen; clears when you open it.
- **"Needs you" overlay (⌘⇧K)** — summon from anywhere a list of sessions blocked on you; arrow keys select, Enter jumps in, and shows how long each has been waiting.
- **Shows what it actually wants** — for a waiting session, reconstructs the real ask (a multiple-choice question, a permission request, a plan approval, or the last thing Claude said) with an honest confidence marker.
- **Command Center** — a cross-project overview listing every session, grouped by project, with the ones needing you pinned on top.
- **Only the real agent is heard** — a one-shot `claude` run started by a hook or subagent shares the event log but can never speak for your session.
- **A restart doesn't invent work for you** — Kriyon replays each session's history at launch to seed status, but a finish only counts as new if it happened while Kriyon was running, and a session reports when it was really last active rather than looking freshly busy.
- **No stale "waiting on you"** — Kriyon checks whether Claude is actually still running inside a session's terminal, not just whether the terminal exists, so a prompt answered before the last restart can't keep asking.
- **Honest "unknown" state** — if a session's watcher goes quiet, it says unknown rather than pretending all is well.
- **Kriyon never answers for you** — every prompt, question, and permission request is answered by you, in the real terminal. Kriyon points you at the session; it never types into it.

## Notifications (macOS)

- **Native notifications** when a session you're *not* looking at needs input, finishes, or errors.
- **Rich content** — names the project and session, a leading emoji for the event type (question, permission, plan, waiting, done, error), and the actual ask text.
- **Click to jump** straight to that session's terminal.
- **Notification preference** — everything / only blocked sessions / nothing.
- **Pick a notification sound** — six tones (marimba, music box, vibraphone, kalimba, bell, or the system alert) plus silent, with a preview button that plays the whole sound.
- **Only fires when it's real** — a notification waits out a settle window and confirms against the terminal that the session actually stopped, and Kriyon reads Claude Code's own notification type rather than guessing from the wording.
- **Withdrawn when it stops being true** — a "needs you" notification is pulled back the moment the session goes back to work.
- **No phantom counts** — sign-ins, finished subagents, rate limits, and turns that flicker don't fire, and the tray and menu bar stop showing counts for work that already finished.
- **Smart muting** — never notifies about the session you're actively viewing, and dedupes bursts.

## Menu-bar quick view (macOS)

- **Menu-bar icon + popover** — at-a-glance view of which sessions need you and which are running, without opening the app.
- **Attention badge** on the icon showing how many sessions need you, even when closed.
- **Finished work counted separately** from what's still running, so a glance tells you whether anything is waiting.
- **Grouped or compact layout**, chosen in preferences.
- **Click a row** to jump into that session.
- **Right-click menu** — Open Kriyon, New session, Preferences, Quit.

## Live activity inspector (right panel)

- **Subagent tracking** — see the nested agents a session spawned, how many are running vs done, each one's task, a live timer, and its current tool.
- **Look inside a subagent** — click a finished one to reveal the result it handed back.
- **Main-agent current tool** — a line showing what the top-level agent is doing right now.
- **Task checklist** — the session's to-do list (pending / in progress / done) with a "n/m done" count.
- **Background shells** — tracks commands the session launched to run in the background, with status.
- **Changed files** — the session's changed files, click one to jump to it in the Changes view.
- **A nested Claude can't pollute the view** — tool use by a one-shot `claude` run started by a hook or subagent isn't blamed on the main agent.
- **Idle state stays visible** instead of vanishing when nothing runs.
- **Git changes, usage, and session info** — uncommitted-change count, ahead/behind, context-window %, token count, cost, branch, start time, and working folder.

## Memory and session lifecycle

- **See what each session is using** — every session shows its live memory footprint.
- **Set a memory budget** (4/6/8/12 GB) in Settings; sessions past it are flagged so a runaway one stops hiding in the pile. Warnings can be turned off.
- **Idle sessions sleep to save memory** — a session left untouched past a cutoff you pick (1h / 3h / 6h, or off) has its `claude` stopped and its memory released, and is marked with a moon.
- **Wakes on its own** the moment you come back to it, picking up the same conversation with a spinner while it resumes.
- **Never slept mid-flight** — a session running a subagent or actively working stays awake. Sleeping state survives a restart.
- **Sleep idle sessions now** — one command (⌘K, or the menu-bar icon's menu) puts every idle session to sleep at once to get memory back without quitting. It never touches a session that is working, on screen, or running a background command, and tells you how many it slept.

## Sessions that survive

- **Survive app crashes** — each terminal runs in its own long-lived background process, so your shell and Claude keep going even if Kriyon crashes or is updated.
- **Closing tells you what it freed** — closing or archiving a session that was holding real memory says so ("Closed — freed about 612 MB"), so you can see that closing is how you get memory back. A session that was holding next to nothing closes silently.
- **Closing frees everything** — closing or archiving a session, or quitting Kriyon, stops everything that session started: Claude, its MCP servers, and any dev server it left running in the background. Nothing is left behind holding memory or a port.
- **Leftovers get cleaned up** — on launch, and every minute while it runs, Kriyon finds session processes that no longer belong to any session and stops them. It only ever touches its own, and does nothing at all if it can't be sure what's still in use.
- **Sessions you haven't opened still count** — after a crash, the sessions that kept running show up in the memory totals and can be put to sleep even before you click on them.
- **Survive a window reload** — reconnects and instantly repaints the screen from a saved buffer, even if the session was idle.
- **Restore on reopen** — closing and reopening Kriyon brings the real Claude conversations back (via resume), not blank shells.
- **Only the session you're looking at resumes on startup** — the rest wake up when you click them, so opening the app is faster.
- **Recover a lost session** — if a resume expires, Kriyon offers a "Start fresh" prompt instead of leaving you stuck, with a boot timeout so the overlay can't spin forever.
- **Terminals recover instead of going dead** — a shell that exits is detected and can be restarted, and a pane repaints when you come back to it.
- **Comes back as the right session** — Kriyon locks onto the live Claude session for status and resume, so a restart doesn't hand you a stale one.
- **A failed start heals** — reopening a session retries a terminal that failed to launch, and a dropped first prompt or a failed launch tells you instead of vanishing.
- **Loading overlay** while a session boots ("Starting Claude…" / "Resuming session…").

## History

- **Find past sessions** — open a folder and Kriyon lists Claude sessions you ran there before, even ones started outside Kriyon, grouped by recency with title, time, and branch.
- **Resume any past session** with a click.
- **"Show more"** paging, with fast cached loading.

## Git: worktrees, diff, merge

- **Isolated worktrees** — run a session on its own branch/working copy so parallel work never touches your main checkout.
- **One new-session dialog** that explains the folder-vs-worktree choice, leads with the branch, and validates the branch name before creating anything — plus the quick per-project **+**.
- **See which sessions are in a worktree** — marked in the sidebar; removing one asks first, with a forced option when you really mean it.
- **Review changes** — see exactly what a session changed since it forked, as a per-file colored diff, without leaving Kriyon.
- **One-click merge** back into the base branch.
- **Conflict surfacing** — if a merge conflicts, the files are listed read-only and you're sent to the terminal to resolve (Kriyon never edits your files).
- **Auto-detects the base branch** to diff/merge against.
- **Keeps working under load** — git operations retry instead of failing when the machine is busy, and status, worktree creation, and merges all run off the drawing thread so the window stays responsive.

## Session lifecycle helpers

- **Spawn a follow-up session** pre-filled with an editable summary of the previous session's work (a built-in handoff).
- **Optional fresh worktree** for the follow-up, with an editable branch name.
- **Auto-setup a new worktree** — copies your `.env*` files, runs the right install command (pnpm/npm/yarn/bun), then an optional per-project setup command, showing progress.
- **Per-project setup command** you can save (e.g. `docker compose up -d`).
- **Collision warning** — warns if another live session already occupies the same folder; you can override.
- **Archive a session** — tidy finished sessions into a collapsed, reversible "Archived" group; offered automatically after a clean merge, optionally removing the worktree too.

## Prompt library

- **Save reusable prompts** with title, body, tags, favorite, and use count — available in every session.
- **Prompt picker (⌘⇧P)** — searchable picker; type to filter, preview, Enter to insert into your message box (never sends automatically). ⌘F favourite, ⌘E edit, ⌘⌫ delete from the picker.
- **Placeholders** — prompts can have `{name}` slots you fill in at insert time; `{clipboard}` fills automatically from your clipboard.
- **Prompts tab** — a full page to browse, search, insert, favorite, edit, and delete prompts with clickable buttons.
- **Promote to a slash command** — turn a saved prompt into a real Claude `/command` file, global or per-project.
- **Import existing commands** — pull your `.claude/commands/` files into the library.
- **Save last prompt** and **"✦ Save prompt"** button in the composer.

## Extra terminals per project

- **Plain shell terminals** alongside the Claude view (for dev servers, builds, log tailing), sharing the project's folder.
- **Tabs and splits** — named tabs; split into side-by-side or stacked panes; ⌘D to split; drag to resize; rename by double-click.
- **Bottom dock** — resizable, with a maximize-to-full-height toggle; opened from a `>_` icon that shows a live pane count.
- **Busy indicator** — detects when a terminal is actually running something and pulses the `>_` icon green.
- **Warns before closing a running terminal** so you don't kill a build by accident.
- **Keyboard chords go where you expect** — app shortcuts are reserved per platform, so Ctrl chords reach the shell and ⌘C still copies.
- **Scrolling works inside full-screen terminal apps** — the wheel sends arrow keys where a scrollback doesn't exist, and stays out of the way in a full-screen app that has a prompt of its own, where those arrows would walk your input instead.
- **Hosts Claude Code's full-screen mode** — a session reattaches into the screen buffer it actually left, and in a session that has taken over the mouse, holding Option drags out a selection or clicks a file path.
- **Your zsh setup loads fully** — every startup file gets sourced.
- **Your shell history works** — past commands and zsh autosuggestions come back properly in the built-in terminal.
- **Terminals stay put** — docked terminals stay live when you switch between them or close the dock, pane sizes survive splitting and closing, and clearing the screen scrolls properly.
- **Survive a reload, stop on quit** — dev servers keep running across a window reload but shut down cleanly when you quit.
- **Layout restored** on relaunch (tabs, folders, split ratios).

## Settings

- **A real Settings page** — reachable from the footer gear, the title-bar gear, or ⌘,.
- **Appearance** — theme.
- **Sidebar** — Calm or Triage layout.
- **Notifications** — which sessions notify, and which sound (with preview).
- **Memory** — warnings on/off, total budget, and the idle-sleep cutoff.
- **Menu bar** — grouped or compact quick-view layout.

## Appearance

- **A calm code palette of its own** — one set of syntax colors for the editor and diffs: a teal keyword, warm functions, and a violet for properties. Switching accent never recolours code.
- **Five color themes** — steel (default), indigo, blue, teal, graphite; switching restyles the whole app instantly, terminal included.
- **Self-hosted Geist and JetBrains Mono Nerd Font**, so type, glyphs and icons render the same everywhere without installing anything.
- **Per-project identity colors**, switchable from the command palette along with everything else.
- **Dark-only, native macOS feel** — one flat cool plane, hairline borders, no gradients and no elevation outside a real overlay.
- **No title bar** — the sidebar carries the Kriyon mark and the navigation, and each column owns its own header; the window drags from any of them.
- **Respects reduced-motion** and meets AA contrast — every stop of the ink ramp that carries text is at or above 4.5:1, enforced by a test rather than by eye.
- **Tab strips work from the keyboard** — Session/Changes and the file tree's tabs are a single Tab stop, with the arrows moving between them and Home/End jumping to the ends.
- **Calm sidebar rail** — read-only work is dimmed and every status color comes from the design palette.
- **Smooth animations** — collapse/expand, pulses, shimmers, hover-reveal controls.
- **No rubber-banding** — overscrolling can't bounce the whole window.

## App & platform

- **Quit means quit** — quitting stops every session and terminal, and the next launch brings each conversation back the first time you open it. A crash, a force-quit or an update is different: those leave your sessions running so you pick up where you were.
- **Kriyon asks before it stops something you'd miss** — quitting, or closing a session, asks first only when there's something to lose, and says what: Claude mid-task, or the background commands that would stop, by name. Idle sessions and ones waiting on you close without a prompt. When Claude is mid-task, quitting offers **Let them finish** — those sessions carry on and stop on their own afterwards. The window's close button and ⌘W quit through the same path.
- **About panel** — app info, real version, company credit link, and a "not affiliated with Anthropic" note.
- **Native macOS menu** with a custom "About Kriyon" opening the in-app panel.
- **The window title follows the live session's transcript**, so a stack of windows is still readable.
- **Layout and session data persist** across restarts (projects, project order and names, sessions, sidebar width, collapsed groups, sort mode, theme, dock state, notification and memory preferences).
- **Error boundaries** — a crash in one region (sidebar, inspector, terminal) shows a fallback instead of blanking the whole app.
- **Stays responsive** — git status, worktree work, history loading, and `@`-mention search all run off the thread that draws the window, and the page is kept within a weight budget so typing and clicking never stall.
- **Less busywork while idle** — Kriyon stops re-reading files that haven't changed, stops rescanning every session to total usage, and looks a session up directly instead of scanning them all.
- **Usage numbers agree** between the message box and the inspector, and a failed read is never counted as a successful one.
- **Signed and notarized macOS release** (DMG).
- **Small footprint** — ~7 MB bundle, ~45 MB idle, built for running many sessions.
- **Uses your own authenticated CLI** — never stores your credentials.

## Keyboard shortcuts

- **⌘K** — command palette
- **⌘⇧P** — insert a saved prompt
- **⌘⇧K** — show sessions that need you
- **⌘,** — Settings
- **⌘D** — split a project terminal
- **⌘N** — new session
- **⌘S** — save the file open in Changes
- **⌘F / ⌘G / ⌥⌘F / ⌘D** — in the editor: find, find next, replace, select next occurrence
- **⌘Enter** — confirm in dialogs
- **Enter / Shift+Enter** — send / newline in the message box
- **⌘C** — clean copy from the terminal
- **Esc** — close any overlay; **arrows + Enter** navigate lists

---

## Not built yet (designed or deferred)

- API-key headless engine for automation/background runs
- A second agent type (Codex / other harness)
- Cross-project "ready to land" review queue
- Containerized / devcontainer isolation
- Cloud sync or multi-user accounts
- Full Linux/Windows polish
- Inline reply from notifications (deliberately never — you answer in the terminal)
- A reconstructed, readable rendering of the conversation (built, then removed — the terminal is the conversation)
- Read-only preview of a past session (clicking always resumes it live)
- Global history browser for folders never opened in Kriyon
- Nested split trees, drag-to-reorder tabs, per-pane shell picker
- Prompt-library folders, versioning, and team sharing
- Staging, committing, or pushing from the Changes view (review and edit only)
