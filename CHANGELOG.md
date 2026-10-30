# Changelog

All notable changes to Kriyon are listed here. Dates are YYYY-MM-DD.

## 0.14.0 — 2026-10-30

Parallel sessions are here. Earlier this month Claude Code's desktop app got
nested sessions, a live task list and turn recaps. Kriyon now has all three,
running on your own `claude` in a real terminal. Ask Claude to split a job up,
and each part runs as its own session, side by side, listed under the one that
asked. When a part is done, its answer comes back on its own. You stay in
charge: only your own words start a session, worktrees are your choice, and
nothing a nested session did gets lost before it's merged.

### Added

- **Nested sessions.** Say "start a session for the tests and another for
  the docs", and Kriyon opens a real session for each, with its own terminal,
  in the same folder or on its own worktree. They run in parallel, sit under
  the session that asked, and report back to it when they finish. When Claude
  has the idea itself, a compact "Claude suggests a session" card waits for
  you to press Start.
- **Split off a session.** "Split off a session…" in a session's menu hands
  part of the work to a new session. Its answer comes back to the session you
  split it from.
- **You set the pace.** Settings decides how many sessions can be busy at
  once: 4 by default, anything from 1 to 16, or no limit. A session you asked
  for that had to wait starts by itself the moment one finishes. Your plan
  limit won't drain in an afternoon by accident.
- **Nothing gets forgotten.** A worktree session's row shows "Not committed"
  or "Not merged" until its work reaches your main branch.
- **Live task progress.** Every row shows Claude's task list as "3/7". A
  strip above the terminal shows the current step and unfolds to the whole
  plan.
- **Context use on every row,** such as "85% ctx", amber from 80%, so you
  know which session is filling up before it slows down.
- **Turn recap.** When Claude stops, a card says what the turn did: files
  changed, commands run, tasks done, and what it needs from you. Review
  changes and Follow up are one click away.
- **Limit pace.** If a plan limit is on course to run out before it resets,
  the Inspector warns you early: "Weekly limit runs out in about 9h at this
  rate".

### Changed

- **Sessions open almost at once.** Rest the pointer on a row and Kriyon gets
  that session ready before you click. The Inspector shows how long the last
  start took.

### Security

- Updated rustls-webpki to fix RUSTSEC-2026-0382.

## 0.13.0 — 2026-10-20

Kriyon is now open source, and it can update itself.

### Added

- **Updates inside the app.** Kriyon tells you when a new version is out and
  installs it when you say so. Your sessions keep running.
- **Install with Homebrew:** `brew install leafycode/tap/kriyon`.
- **Easier to read conversations.** Your messages and Claude's replies now
  look different, so you can tell them apart at a glance.

### Changed

- **Clearer activity.** You can see at a glance what Claude changed on your
  computer, such as installed or deleted files.
- **New font and colors** for text and code.

### Fixed

- The Structured view now matches the terminal more closely.
- Pasted text and long messages show and send correctly.
- The message box fits small windows.
- Closing a session cleans up its leftover files.
- Release notes no longer show hidden comments.

### Security

- Tighter limits on what the app window can load.

## 0.12.0 — 2026-10-11

The Structured view now works on its own: Claude Code's dialogs open over it,
it shows what Claude is doing step by step, and `/usage` opens Kriyon's own
usage card. Usage shows only figures Claude Code reports exactly, including
your plan limits.

### Added

- **Answer dialogs from the Structured view.** Questions, permission prompts,
  plan approvals and slash-command menus (`/mcp`, `/model`, `/config`, …)
  bring up the session's terminal over the view until they close. The
  composer doesn't send while a dialog is open.
- **More of what Claude is doing.** Claude's messages between tool calls show
  in place. The working line names the current task and the step in progress,
  and a long Write shows its file name.
- **Kriyon's own `/usage` card.** In the Structured view, `/usage` or `/cost`
  opens a live card in the conversation instead of a full-screen pane in the
  terminal. It shows the context window and your 5-hour and weekly plan
  limits, with amber at 80% and coral at 100%. "Claude's full panel" still
  opens Claude Code's own pane. The slash menu tags these commands "Opens
  here".
- **Plan limits.** The Inspector's Usage section shows your 5-hour and weekly
  limits, how much is used and when each resets. They come from the status
  line Claude Code reports, kept current from every `claude` you run, in
  Kriyon or not. No extra API calls, no credentials read.
- **Exact context.** The context bar uses Claude Code's own percentage and
  token count, and shows "—" rather than an estimate when there is no reading.

### Changed

- **Kriyon Companion is on by default** on the welcome screen, since the
  Structured view needs it. Saved preferences are left as they are.
- **The Structured tab is never disabled.** With the companion off, it offers
  "Turn on Kriyon Companion".

### Removed

- **Session cost and token totals**, in the Inspector and the sidebar footer.
  The cost was an API list-price estimate nobody on a Pro or Max plan pays,
  and no documented source gives an exact token total.

### Fixed

- **A `claude` started inside a session no longer takes it over.** A nested
  `claude` (from a Bash command or a script) could mark the session done,
  point it at another conversation or rename it. Only the `claude` holding the
  session's terminal now speaks for it.
- **"Claude is working…" no longer hangs** after a slash command such as
  `/usage`, `/stats` or `/skills`, after a dialog closes, or after a send from
  the Raw view.
- **Slash commands show properly.** Commands the CLI runs itself show as their
  own turns, `/output-style` and `/agents` show their output as the reply, and
  a command run mid-turn no longer splits Claude's turn.
- **A permission prompt no longer blocks sending** while the approved tool
  runs.
- **Esc in the Structured view leaves an open dialog alone.**
- **The hidden terminal keeps its real size** and gives up keyboard focus.

## 0.11.0 — 2026-10-08

The Structured view is now a full chat view: you can stop Claude, attach files
and screenshots, and watch the reply as it is written. Links in the terminal
and in replies open again.

### Added

- **Stop from the composer.** Esc in the composer, in the Structured view or
  in the terminal, or the Stop button, stops Claude the way the CLI's own Esc
  does. A message Claude hadn't started on comes back to the composer, with its
  attachments.
- **Attachments.** Add files and images with the paperclip, a paste (a
  screenshot, or files copied in Finder) or a drop on the window. Images reach
  Claude as pictures and other files as `@` mentions, the same way the
  terminal takes them. Pictures Claude can't see (HEIC, AVIF, TIFF, BMP, SVG)
  are converted first, and you are told. An image over 8000 px gets a warning.
  Pasted images are kept for 30 days so history can still show them.
- **The reply streams in** as Claude writes it, instead of arriving when each
  block is finished.
- **A fuller Structured view.** Each turn shows its images as thumbnails that
  open full size, an Interrupted marker, its time and duration, and a button
  to copy the reply. Code blocks have copy buttons. The view follows new output,
  stops when you scroll up, and offers Jump to latest. The tip Claude Code
  shows under its spinner appears under the working line.
- **Links in replies.** URLs, file paths and Markdown links in the Structured
  view open on a click, and Cmd+click reveals a file in Finder. A file outside
  every project opens only after you confirm.
- **Prompt history.** Up and Down in the composer walk the prompts you have
  sent in that folder, from the terminal or the composer.
- **Mascots.** Pick one of three orb mascots, in a colour of your choice. It
  thinks while Claude works.
- **Your session view is remembered.** Kriyon opens new sessions in the view
  you last chose (Session or Structured), and the welcome screen asks which you
  prefer.

### Fixed

- **Links in the terminal open again.** A plain click on a URL or a file path
  opens it even while a fullscreen `claude` has the mouse, and Cmd+click
  reveals a file. Absolute paths keep their leading `/`, and a link that can't
  open now says why instead of doing nothing.
- **A session stops reading as working after an interrupt.** Claude Code sends
  no signal when you stop a turn, so the status could stay at Running. It
  now ends when Kriyon sees the turn stop, even when you stop it with Ctrl+C in
  the terminal.
- **Waiting on background agents isn't Done.** A turn that hands work to
  background agents no longer shows as Done while they still run.
- **Text pastes as plain text** in the composer, with its line breaks kept.

## 0.10.0 — 2026-10-05

Kriyon now asks before it adds anything to Claude Code, loads its hooks only in
its own sessions, and keeps a log of what Claude did in each one. An optional
companion adds exact session state and a Structured view.

### Added

- **A welcome screen on first run.** It says plainly what Kriyon adds to Claude
  Code, with a switch for each part. Nothing is written until you click
  Continue, and Cancel quits.
- **Hooks only in Kriyon's sessions.** Kriyon's hooks now load as a plugin in
  the sessions it starts, and its old entries leave `~/.claude/settings.json`.
  Only the status-line wrapper stays there, behind its own switch; turning it
  off puts your own status line back. If your organization blocks per-session
  plugins, the hooks go to `settings.json` instead, and Settings says why.
- **Settings → "What Kriyon adds to Claude Code".** A switch per part, and
  "Remove from Claude Code", which first lists what it will take out.
- **Activity tab** in the right panel. Each turn's prompt and its steps, newest
  first, with filters (Changes, Commands, Needs a look) and flags for steps
  worth a look: a package installed, files deleted, the internet used, a file
  outside the project, a secret file. Click a step for its input, result, what
  allowed it and how long it took; edits open in the Changes view. The log stays
  on this Mac for 30 days (up to 500 MB), known secrets are hidden on a
  best-effort basis, and you can delete it per session or all at once.
- **Kriyon Companion (optional, off by default).** A read-only mod that tells
  Kriyon exactly what each session is doing. It never approves, blocks or
  changes anything, and sends nothing off this Mac. A chip in the session
  header shows whether it is on.
- **Structured view.** While the companion is on, the session's first tab shows
  each prompt, a folded "What Claude did", and the reply with its formatting.
  A prompt you send shows at once, with a "Claude is working…" line.
- **CPU next to memory** for each session, and the total in the menu-bar
  popover.
- **Handoff pickup.** When a session runs your own `/…handoff` skill or writes a
  `*handoff*.md` into the temp folder, a card offers to start a new session
  from it, with the handoff's own starting prompt. The new session links back
  with "↓ from <session>".
- An Apache-2.0 licence, and an About panel note that Kriyon is independent of
  Anthropic and uses your own Claude plan.

### Fixed

- **Your Claude Code settings reach `claude` again.** Kriyon stripped every
  `CLAUDE_CODE…` variable from a new session, including your renderer choice,
  plugin folders and login settings. It now strips only the markers that make
  `claude` think it is nested inside another session.
- **A click in a fullscreen `claude` no longer also opens a link.** Links open
  when nothing has captured the mouse, or on Option+click.
- **"Status unavailable" when hooks are off.** With `disableAllHooks` or a
  managed hooks policy, a session used to read "idle" forever. The row now says
  status is unavailable, and where hooks were turned off.

## 0.9.2 — 2026-10-01

The menu-bar popover works again, and sessions running background agents stop
claiming to be done, or to need you, while the agents are still working.

### Fixed

- **The menu-bar popover opens again on macOS 27.** macOS 27 changed how
  menu-bar icons handle clicks, so a left-click showed the right-click menu
  instead of your running and waiting sessions. Kriyon now uses Tauri 2.12,
  which handles the new behaviour.
- **The popover's buttons do what they say.** New session opens the folder
  picker, as the sidebar's button does; before, it raised the window and
  nothing else happened. The gear opens Settings rather than the command
  palette.
- **⌘N starts a new session.** The tray menu has always shown ⌘N, but nothing
  answered it. File → New Session now does, from anywhere in the app.
- **A session waiting on background agents is no longer marked Done.** Claude
  Code now runs subagents in the background by default, so a turn can end
  while its agents keep working. Kriyon shows "Waiting on N agents…" and keeps
  the session running until they finish. It announces the real finish, and it
  no longer says the session needs you because of an agent's idle nudge.
- **A subagent's permission prompt clears when that agent carries on.**
  Before, the needs-you badge stayed lit for as long as any background agent
  ran.
- **Status and the Details rail agree after a restart.** They now read the
  session history the same way, so they can no longer settle on different
  sessions.

### Changed

- Tauri moves to 2.12 (with its plugins), and React to 19.3.

## 0.9.1 — 2026-09-22

### Fixed

- **Kriyon no longer crashes on macOS 26.** Hovering over selected text brings
  up the system's Writing Tools bubble, and a bug in it raises an alarm macOS
  expects the app to absorb. Kriyon couldn't — the window toolkit it is built
  on turned that alarm into an instant quit, with no error to show for it. Now
  it is caught and logged: you lose the one mouse event, not your work.

## 0.9.0 — 2026-09-20

A new look, and the title bar is gone. Kriyon sits on one flat, cool plane
now, where depth is a hairline and a small step in lightness rather than a
gradient or a shadow. The strip of unrelated controls that used to run above
everything has been dealt out to the columns that own them: navigation lives
in the sidebar, and each column carries its own header. Separately, Kriyon
now hosts Claude Code's full-screen mode properly — a growing number of
people already have it on by default.

### New

- **No title bar.** The window is one row of columns, each owning its top
  46px, and it drags from any of them. The Kriyon mark sits in the sidebar's
  own strip beside the traffic lights, where the space was already reserved.
- **Navigation moved into the sidebar.** Sessions, Command center and Prompts
  are rows with live counts; Settings and About sit in the footer. Focus stays
  an icon button rather than a destination — it hides the chrome, it isn't a
  place to go.
- **A cooler, quieter palette.** New ink ramp, GitHub-ish status colors, and
  no gradients or raised shadows anywhere in the chrome. Real overlays still
  get a shadow, because they are genuinely above the page.
- **Steel is the new default theme,** tuned for the cool chrome. Indigo, blue,
  teal and graphite are all still there and now layer on the new plane — if
  you picked one, it stays picked.
- **Satoshi throughout,** with JetBrains Mono keeping everything
  machine-shaped: counts, branches, paths and key caps.
- **The tabs read Session and Changes** — "Raw" and "Files & Changes" were
  names for what the code called them, not for what you look at.
- **The message box is a card, not a popover,** the Details rail is re-cut on
  clean key-value rows, and the terminal dock is one flat plane with hairline
  seams instead of a stack of boxes.

### Improved

- **Claude Code's full-screen mode works properly now.** If your `claude`
  draws itself full-screen — increasingly the default — reattaching to a
  session no longer leaves Kriyon painting that screen into the wrong buffer,
  and the scroll wheel no longer walks back through your prompt history when
  it should be doing nothing. Hold Option to drag out a selection or click a
  file path in a session that has taken over the mouse; ⌘C over such a session
  still does nothing, deliberately, because the key it would have to send is
  indistinguishable from an interrupt.
- **The contrast promise is true rather than claimed.** Every ink stop that
  carries text is at or above 4.5:1 on the new background. About thirty places
  were using a stop that doesn't clear it, and two tests now compute the ratios
  so a later palette tweak fails the suite instead of shipping.
- **Tab strips work from the keyboard.** The Session/Changes tabs and the file
  tree's own are one Tab stop, with the arrows moving between them and
  Home/End jumping to the ends — they announced themselves as tabs long before
  they behaved like them.
- **Icons instead of text glyphs** in the rail and its panels, so nothing
  depends on a font happening to have a character.

### Fixed

- **The Activity line said "Working…" over a Done pill.** It now means work
  actually in flight. Background shells are listed rather than counted toward
  it.
- **An empty Changes view said "no changes" for a folder that isn't a git
  repository at all.** It says which it is.
- **Enter in the Needs-you overlay could fire twice** — once to open the
  session, and once on whatever control had focus inside the panel.
- **The sidebar's + stays visible** now that the empty state tells you to
  press it.

### Under the hood

- The restyle converged roughly 150 one-off style objects onto a single module
  of style recipes, rather than a component library — the theme seam wants
  style objects, so the thing worth sharing is the object. Recorded as
  ADR 0023, along with the five words the direction introduces.
- The 46px band every column owns is now one module, which also holds the
  macOS traffic-light clearance. The rule ADR 0023 stated — a header that
  forgets it is a window you cannot drag, and, with the sidebar collapsed, one
  you cannot get the sidebar back from — is finally enforced by a test rather
  than by remembering.
- ADR 0024 records the decision *not* to force Claude Code's full-screen
  renderer on. Which renderer runs is a setting inside the user's own CLI, and
  Kriyon does not overrule it; the work above is about hosting it correctly
  when it is already on.

## 0.8.0 — 2026-09-09

Two threads. The Changes view became a place you can actually work: a real
editor with find and replace, change marks in the gutter, and create, rename
and delete right in the file tree. And Kriyon stopped redrawing the
conversation — a session is now its terminal and its files, nothing else.

### New

- **Find and replace, and more than one cursor.** ⌘F to find, ⌘G for the next
  hit, ⌥⌘F to replace, and ⌘D to grab the next copy of what you selected.
  Alt-drag for a block selection, and brackets and quotes close themselves.
- **Change marks in the gutter.** Lines you or Claude added, changed, or
  deleted since the last commit are marked down the left edge, the way VS Code
  and Cursor do it. Untracked files and files too big to read get no marks
  rather than wrong ones.
- **Create, rename and delete from the file tree.** Right-click any row: New
  File, New Folder, Rename, Delete — with inline naming, like VS Code. Delete
  goes to Finder's Trash, so it's recoverable. The same menu also has Open in
  Editor, Reveal in Finder, Copy Path, and Copy Relative Path.
- **Throw away a file's changes.** A **Discard edits** button in the file viewer
  puts the file back to its last committed state. It only appears when it can
  actually do something — an untracked file, or one that already matches,
  doesn't offer it.
- **Edit a file straight from its diff.** An Edit button on a diff card takes
  you to that file in the editor instead of making you hunt for it in the tree.
- **Unsaved work shows in the tree.** A dot marks any file with edits you
  haven't saved — including drafts for files you've since closed, which used to
  be invisible.
- **Collapse or expand every diff at once.** Two buttons in the summary bar turn
  a hundred-file review into an outline. Per-file toggles still work after.
- **The tab is now "Files & Changes."** It stopped being only about changed
  files a while ago.
- **Kriyon asks before quitting on working sessions.** Quitting mid-turn used to
  happen without a word. The warning names what's at stake — a terminal that
  gets stopped, a session that would keep working unwatched, or both. Sessions
  waiting on you don't count as working, so they don't prompt.
- **Closing a session with unsent work asks first.** An unsent message or an
  unsaved file edit gets a confirm instead of vanishing. A clean session still
  closes straight away.
- **Clear a project, and let quiet ones fold away.** The project header's ⋯ menu
  closes every session in it behind a two-step confirm. Separately, a project
  whose sessions have all gone stale collects into one "N inactive projects"
  row at the bottom of the rail — expandable in place, with each one showing how
  long it's been quiet.
- **Same-named projects tell themselves apart.** Two folders both called
  `acme` now show just enough of the path to separate them. Unique names get
  nothing extra.
- **The focus rail goes to the session that wants you.** It picks a session
  waiting on you first, then one that's working, then the most recent — instead
  of always the oldest.

### Improved

- **A new code palette.** Code is no longer colored like VS Code's Dark+: a teal
  keyword, warm functions, and a color of its own for properties.
- **The whole message box takes a click.** Pressing anywhere in the box focuses
  the text and puts the caret at the end. Before, only the one line of text
  itself worked.
- **The Changes tab gives diffs the full height.** The message box is a writing
  tool; it's gone from a reading view. Your draft is kept and comes back.
- **Failures look like failures.** Error toasts get their own mark and stay up
  longer, raw internal error strings stop reaching the screen, and copying a
  path tells you whether it worked.
- **Keyboard and screen-reader fixes.** Menus announce themselves as menus,
  closing an overlay returns focus where it belongs, and a panel that hit an
  error offers Try again instead of staying broken.

### Fixed

- **Every text box in the app went untypable.** Renaming, the command palette,
  and the prompt editor took focus, flashed a caret, then dropped it, and
  keystrokes went nowhere. A guard meant to clean up stray carets was deleting
  the real one on every keystroke, because WebKit reports a focused field's
  caret as sitting on the element *around* it.
- **The window's close button did nothing.** So did ⌘W. Both now quit Kriyon,
  through the same path as Quit in the tray, with the busy-session warning
  intact.
- **The editor showed stale content.** A file that changed while the editor was
  still loading kept the old text until you reopened it.
- **"Changed on disk" stopped crying wolf** after your own save.
- **An outside change no longer wrecks your undo or your caret.** When Claude
  edits the file you have open, the reload keeps your cursor and scroll position
  and stays out of undo history — ⌘Z used to jump back to before Claude's edit.
- **A deleted file says so** instead of showing content that isn't there any
  more, and offers to keep your draft.
- **The editor no longer opens blank.** Opening a file while the pane was hidden
  could leave an empty editor until you clicked it.
- **Windows line endings survive a save.** A CRLF file stays CRLF, and a mixed
  file follows whichever ending it mostly uses.
- **Clicking a file in the diff feed opens the right file** when the session's
  folder and the repository root differ — including the macOS `/private` case
  that made every path look foreign.
- **Renaming or deleting no longer freezes another session's tree.**
- **A rename or delete can't smuggle a path separator** into a new name.

### Removed

- **The clean readable view of the conversation is gone.** A session now shows
  its real terminal or its files, and the tab strip reads just
  **Files & Changes | Raw**. The reconstructed transcript pane — your prompts,
  Claude's replies, tool calls, bash output, diffs, and code blocks redrawn as
  tidy blocks — never earned its place next to a terminal that already shows all
  of it, correctly, live. Everything it uniquely offered went with it: the
  "Thinking" line, the read-only question cards and their "Answer in terminal"
  button, the waiting banner, the resume hint, the per-turn changed-files chip,
  and the instant echo of a message you just sent. Clicking file paths and links
  still works — in the terminal, where the output is.
- **The catch-up banner is gone.** The dismissible "here's what happened while
  you were away" summary went with the pane it sat on. The sidebar still tells
  you which sessions finished with output you haven't seen.

### Under the hood

- Kriyon still reads each session's transcript in the background. It is what
  keeps token, context, and cost numbers honest, marks which sessions have
  output you haven't looked at, works out what a waiting session actually wants,
  names your sessions, and pre-fills the handoff when you spawn a follow-up.
  None of that is drawn from the terminal, and none of it changed.
- Eight parts of the codebase that had spread themselves thin were pulled back
  into single owners: one place decides when a diff re-runs, one view model
  feeds the Changes view instead of thirteen separate reads, one type guards
  every file path crossing into Rust, and one factory replaces seventeen
  hand-written event listeners. Recorded as ADR 0020 and ADR 0021.
- The new create, rename and delete commands needed a sandbox rule that can name
  a file which doesn't exist yet. It resolves the parent folder the strict old
  way and then allows only a plain filename — no separators, no `..`, no
  symlink games. A related audit found and closed a hole where a path was
  checked one way and handed to git another.
- The marketing site got a pass of its own: responsive images and a lighter
  first frame took its mobile score from 74 to 95, with accessibility, SEO, and
  best practices at 100, plus a real 404 page and a mobile nav that no longer
  covers the hero.

## 0.7.0 — 2026-07-25

You can now see what a session actually changed, without leaving Kriyon. Every
session gets a Changes view — the files it touched, the diffs, and a browser and
editor for the whole project. Alongside it, notifications stop crying wolf, and
two ways the window could lock up are gone.

### New

- **See what a session changed.** A Changes view sits next to the transcript: a
  scrolling feed of syntax-highlighted diffs, a file tree beside it, and a rail
  down the edge to jump between files and mark them viewed. A summary at the top
  keeps the file count and the lines added and removed in view.
- **Each session shows its own work, not the whole repo.** Kriyon takes a
  private snapshot of the working tree when a session starts and diffs against
  it, so two sessions on the same checkout no longer show the identical pile of
  changes. It catches edits made by any means — a `sed`, a formatter, a script —
  and a change that gets reverted disappears again. Files that were already
  dirty before the session began stay out of the way.
- **Know which edits are this session's.** Files this session touched carry a
  `✎ this session` badge, and a toggle narrows the list to just those — the one
  honest signal when two sessions share a checkout.
- **Browse every file in the project.** An all-files tab opens the project tree
  and shows any file with its changed lines marked in the gutter.
- **Edit and save a file in place.** Open a text file and it opens in an editor,
  not a viewer. Save with the usual chord. Unsaved work follows you between
  files, and if something else changed the file underneath you, Kriyon says so
  instead of overwriting it. Binary files and files that aren't valid text stay
  read-only so a save can't corrupt them.
- **Open a file in your own editor.** A file opens in the editor you use for
  code, not whatever the system picked for that file type.
- **The diff keeps up on its own.** As Claude edits, runs a command, or hands
  work to a subagent, the view refreshes — with a quiet marker rather than
  yanking the page while you're reading.
- **Jump straight to a change.** The Inspector lists the session's changed files
  and clicking one scrolls the feed to it, the transcript shows a changed-files
  chip, and the sidebar carries a badge. Clicking a session and coming back puts
  you where you were.

### Fixed

- **Notifications stop firing at the wrong moment.** Four separate causes, all
  measured against real event logs:
  - A one-shot `claude` run started by a hook or subagent could take over as
    "the session" — one log held 40 different Claude ids, 39 of them one-shots —
    and announce a finish that never happened while muting the real session.
  - "Needs you" is now withdrawn when the session goes back to work. Answering a
    prompt, or Claude resuming on its own, used to leave the banner sitting
    there reading as if it still needed you.
  - A state that flickers no longer pings. A notification now waits out a short
    settle window, and confirms against the terminal that the session really
    stopped, before it fires.
  - Kriyon reads Claude Code's own notification type instead of guessing from
    the wording, and listens to the failure events Claude Code actually sends.
    Six kinds of misfire — sign-ins, finished subagents, rate limits — go away.
- **The window no longer freezes while you type or click.** Two causes: WebKit
  was re-scanning the entire page on every edit because sending a message left
  the text cursor pointing at nothing, and open session panes were never
  released, so a long day could leave ninety of them on the page at once. Both
  are capped and guarded — the page went from 15 million elements to one, and an
  8.6-second stall to none.
- **An unsaved file survives its pane being closed.** Your draft is kept and
  comes back when you reopen the file.
- **A session folder that isn't a git repo says so** instead of showing an
  error.

### Under the hood

- The Changes view's IPC commands went through a security audit: reads and
  writes are sandboxed to known project roots, untracked symlinks can't disclose
  paths outside the repo, and saving preserves file permissions and won't
  silently truncate a large file.
- Snapshots reuse a persistent scratch index kept inside the repo's own git
  directory, roughly five times faster and invisible to your working tree or
  hooks. Diff rows, the file tree, and syntax highlights are memoized so
  scrolling a hundred-file view stays smooth.
- Development builds warn when the page grows past its weight budget — the
  actual invariant behind the freeze, which a pane count could never catch.

## 0.6.0 — 2026-07-24

Two threads. The sidebar bends to how you actually think about your work —
arrange your projects and name anything that matters to you. And Kriyon keeps
its own memory in check: it shows what each session is using and quietly puts
long-idle ones to sleep so a day of sessions stops eating your machine.

### New

- **Put your projects in the order you want.** Drag a project into place using
  the grip that appears when you hover its header. Your arrangement sticks
  across restarts and holds in both calm and triage — the order you set is the
  order you see. Newly opened projects sit at the top until you place them.
- **Rename a project.** Double-click its header, or use the pencil that appears
  on hover, and type a new name. Press Enter to keep it, Escape to back out.
- **Rename a session.** Double-click its title, or pick Rename from its ⋯ menu.
  The name you give it stays put — Claude renaming the session in the background
  can no longer overwrite a name you chose yourself.
- **See what each session is using.** Every session shows its live memory
  footprint, and you can set a budget in Settings — sessions past it are flagged
  so a runaway one stops hiding in the pile.
- **Idle sessions sleep to save memory.** A session left untouched long enough is
  put to sleep — its `claude` is stopped and its memory released — and marked
  with a moon. It wakes on its own the moment you come back to it and picks up
  the same conversation, with a spinner while it resumes. Sessions running a
  subagent are never slept mid-flight, and sleeping state survives a restart.

### Under the hood

- The auto-sleep lifecycle lives in one module with an explicit stuck state, the
  process table is indexed once per sweep, and wakes are confirmed by
  observation rather than assumed — hardened against a multi-agent adversarial
  review.

## 0.5.1 — 2026-07-20

A sidebar tidy-up, the end of Kriyon crying wolf about sessions that were never
waiting on you, and a round of work on the freezes.

### Fixed

- **Typing in the composer no longer freezes the app.** Looking up a file for an
  `@` mention searched your project folder on every single keystroke, and did it
  on the thread that draws the window — so the whole app stopped until it
  finished. On a big project that was seconds at a time. The search now runs out
  of the way, waits for you to stop typing, and stops early on huge folders.
- **The app stays responsive while it works.** Reading a repository's status,
  creating or merging a worktree, and loading a session's history all ran on the
  same thread that draws the window. Checking git status alone happened every
  time you switched sessions, so a busy sidebar could stall the window for no
  visible reason. All of it now runs out of the way.
- **The command list opens instantly.** Typing `/` used to render every command
  you have installed — hundreds of rows — and re-measure the whole list on each
  keystroke. It now shows the best matches only.

- **"Needs you" no longer fills with old, finished sessions at launch.** Kriyon
  re-reads each session's history when it starts, and was counting all of that
  replayed output as unread — so every session you had already reviewed came
  back asking for attention. A finish is only new if it happens while Kriyon is
  running.
- **A nested Claude can no longer speak for your session.** A one-shot `claude`
  run started by a hook or a subagent shares the session's event log. It could
  invent a question you never saw, and worse, its exit could clear a real one —
  quietly dropping a genuinely blocked session out of "Needs you" while the
  terminal sat waiting. Only the session's main agent is heard now.
- **"Hide older than" works again after a restart.** Kriyon re-reads each
  session's history when it starts, and was treating those replayed updates as
  "this session was just active" — so every session looked fresh and nothing was
  ever old enough to fold away. A replayed session now reports when its last
  activity actually happened.
- **A stale "waiting on you" no longer survives a restart.** Kriyon checked
  whether a session's terminal process still existed, but those outlive the app
  by design, so the check passed for everything. It now checks whether Claude is
  actually still running in that terminal. On a machine with 31 live terminals,
  9 were sitting idle and would have kept showing stale prompts.

### Improved

- **The session list reads as one column again.** Session titles line up with
  their project name instead of drifting to the right, finished sessions stop
  sitting a few pixels off from the rest, and the per-project count sits at the
  far edge of the rail. The sort, color, and new-session buttons now appear over
  the count on hover rather than pushing it inward and squeezing long names.

## 0.5.0 — 2026-07-20

This release is about making the session list yours and the terminal dependable.
Sessions can be sorted or dragged into the order you want, old ones fold away,
notifications get their own sound, and a round of terminal work removes the ways
a pane could go dead or lose your keystrokes.

### New

- **Put sessions in the order you want.** Sort a project's sessions by date or
  name, or drag them into a manual order using the grip that appears on hover.
  The choice is global, and any project can override it.
- **Fold away old sessions.** Sessions past an age you pick collapse into a
  single "N older" line per project, so the list stays about today's work. The
  cutoff lives in the sort menu and survives a restart.
- **Pick a notification sound.** Settings now offers six tones — marimba, music
  box, vibraphone, kalimba, bell, or the system alert — plus silent, with a
  preview button so you can hear one before choosing.
- **The menu bar counts finished work separately** from what's still running, so
  a glance tells you whether anything is waiting on you.
- **The title bar carries the Kriyon mark** instead of a terminal prompt.

### Improved

- **Terminals recover instead of going dead.** A shell that exits is detected and
  can be restarted, a pane repaints when you come back to it, and quitting with
  work in flight asks first.
- **Keyboard chords go where you expect.** App shortcuts are reserved per
  platform, so Ctrl chords reach the shell and Cmd-C still copies.
- **Scrolling works inside full-screen terminal apps** — the wheel sends arrow
  keys where a scrollback doesn't exist.
- **Calmer sidebar rail**, matched to the design palette.

### Fixed

- **No more phantom badges.** Session state is seeded from event history and
  notifications are classified by their message, so the tray and menu bar stop
  showing counts for work that already finished.
- **Preview sounds play to the end** instead of being cut off partway.
- **Hidden panes no longer crash on resize**, and the window title follows the
  live session's transcript.
- **Dragging a session no longer launches it**, and stale sessions can't win a
  race against live ones during startup.

### Under the hood

- Session status, the ask state, and notification decisions now live in one
  session runtime with a single event subscription; the layout blob has a proper
  parser; the sidebar's worktree flow and header actions are separate seams.
  No behavior change.

## 0.4.0 — 2026-07-15

This release is about starting work in isolation and making the app feel quick.
A session can now run on its own branch in its own worktree, and a performance
pass cuts launch time and idle work.

### New

- **Start a session in its own git worktree.** One new-session dialog now
  explains the folder-vs-worktree choice, leads with the branch, checks the
  branch name before creating anything, and keeps the quick per-project **+**.
- **See which sessions are in a worktree.** The sidebar marks them, and removing
  one asks first — with a forced option when you really mean it.

### Improved

- **Quicker launch, smaller app.** The release build is tuned and unused
  dependencies are gone.
- **Snappier typing.** Terminal input now goes to the shell as raw bytes.
- **Less busywork while idle.** Kriyon stops re-reading files that haven't
  changed, stops rescanning every session to total usage, and looks a session up
  directly instead of scanning them all.
- **Your zsh setup loads fully** — every startup file gets sourced, not just some.
- **The whole session row is clickable**, not just part of it.
- **Calmer sidebar.** Read-only work is dimmed and status colors follow the
  design palette.

### Fixed

- **The About panel shows the real version.** It was stuck reporting 0.1.0 no
  matter which version you were running.
- **Terminals stay put.** Docked terminals stay live when the dock closes, pane
  sizes survive splitting and closing, and clearing the screen scrolls properly.
- **Sessions start more reliably.** A failed terminal start now heals when you
  reopen the session, and the loading overlay no longer depends on timing.
- **Nothing gets lost silently.** A dropped first prompt or a failed launch now
  tells you instead of vanishing.
- **git keeps working under load** — it retries instead of failing when the
  system is busy.
- **Usage numbers agree** between the message box and the inspector, and a failed
  read no longer counts as a successful one.
- **Sessions stop shuffling** in the sidebar.

### Under the hood

- Session boot, warm panes, the watcher's read gate, and sidebar ordering each
  moved into a single tested place; added ADRs for worktree ownership and the
  session-engine seam. No behavior change.
- The app version now lives only in `package.json`; the bundle and the About
  panel both read it, so they can't drift apart again.

## 0.3.0 — 2026-07-11

This release makes Kriyon a calmer command center. Links in Claude's output are
now clickable, the sidebar has two moods, and there's a proper Settings page.
Plus a round of session-recovery and reliability fixes.

### New

- **Click paths and links in Claude's output.** File paths and URLs are now
  live in both the terminal and the structured view. Click a file to open it;
  Cmd-click to reveal it in Finder. Only known project and session folders can be
  opened, and only safe file types — no surprises.
- **Calm and Triage sidebar modes.** Pick the view that fits: Calm keeps things
  quiet, Triage surfaces what needs you. Done sessions tuck into a collapsible
  group so the list stays short.
- **A real Settings page.** One place for theme, sidebar mode, notifications, and
  the menu-bar view — reachable from the footer gear, the title-bar gear, or ⌘,.
- **Recover a lost session.** If a resume expires, Kriyon now offers a
  "Start fresh" prompt instead of leaving you stuck.

### Improved

- **Sessions resume more reliably.** Kriyon locks onto the live Claude session
  for status and resume, so the right session comes back after a restart.
- **Only the session you're looking at resumes on startup** — the rest wake up
  when you click them, so opening the app is faster.
- **Trackpad scrolling feels right.** The terminal now scrolls by actual finger
  distance; only mouse-wheel notches get amplified.
- **Snappier sidebar.** Rows stop re-rendering when nothing changed, and the
  session scan no longer runs twice.

### Fixed

- **No more rubber-banding.** Overscrolling can't bounce the whole window
  anymore.
- **A waiting session shows what it's actually asking**, not a generic
  "needs permission" line.
- **Studio stops making dead links.** URLs and commands are no longer styled as
  clickable file paths that go nowhere.
- **A nested Claude's tool use no longer gets blamed on the main agent** in the
  activity view.
- **The recovery overlay can't hang.** Starting fresh now arms a boot timeout, so
  a stuck start doesn't leave the overlay spinning forever.

### Under the hood

- Consolidated session-resume and path-matching logic into single tested places
  across the Rust core and frontend; added an ADR and integration tests for the
  main-session lock. No behavior change.

## 0.2.0 — 2026-07-08

The big one this release: the message box now helps you type. Plus a batch of
terminal and sidebar fixes that make everyday use smoother.

### New

- **Type-ahead in the message box.** Start typing and Kriyon suggests as you go:
  - `/` shows Claude's slash commands, pulled from your actual setup (built-in
    commands, your custom ones, and plugin commands) — not a hardcoded list.
  - `@` shows files and folders from the project, and your agents. It respects
    `.gitignore`, so build output and junk don't clutter the list.
  - A leading `!` or `#` is recognised as a bash or memory shortcut.
- **Suggestions become colored chips.** Once you pick one, it turns into a tidy
  colored pill — a different color per type (command, file/mention, agent, mode).
  You can delete a whole chip in one press instead of character by character.
- **Suggestions float above everything**, so an open terminal can never hide the
  list, and the box lines up cleanly with the text as you type.

### Improved

- **Smoother terminal scrolling.** Mouse-wheel scrolling is snappier, with a
  clean overlay scrollbar that fades in only when you scroll.
- **Your shell history works again.** Past commands and zsh autosuggestions come
  back properly in the built-in terminal.
- **Switching terminals no longer blanks them.** Docked terminals stay live when
  you flip between them.
- **Cleaner Studio view.** Claude's output no longer runs into the edges of the
  pane.

### Fixed

- **One click to open a session.** Opening a session from the sidebar takes a
  single click again (it sometimes needed two).
- **Newest sessions first**, and the "done" marker no longer flickers.
- **Long titles stay tidy** in the sidebar instead of overflowing their row.
- **No more double notifications** — a session that's ready notifies you once,
  not twice.

### Under the hood

- Security housekeeping: patched some development-only dependency advisories.
  These never shipped in the app; no user-facing impact.
- Internal cleanup and more tests for reliability. No behavior change.

## 0.1.0 — 2026-07-06

The first release. Kriyon runs your own Claude Code CLI in a real terminal and
builds a live, readable view of what it's doing around it.

### New

- **Your real Claude, in a real terminal.** Kriyon hosts your own authenticated
  `claude` CLI in a full zsh terminal — your shell, your history, your setup.
  Each session runs under its own background process that survives an app crash,
  so your work keeps going.
- **A sidebar for everything you're running.** Projects and sessions grouped and
  colored, with status-first rows, a live filter, collapsible groups, a live
  activity badge, and a resizable rail.
- **Studio: a readable view of Claude's output.** Kriyon reconstructs the
  transcript into something you can scan — questions become cards, thinking is
  visible, and a catch-up brief tells you what happened while you were away. It
  never breaks on output it doesn't recognise.
- **Inspector.** See the agents, tasks, and background work of a session,
  including live subagent timers and the tool the main agent is on right now.
- **Know when Claude needs you.** Kriyon works out what a waiting session is
  actually asking for and pins it in a Needs-you section, with a ⌘⇧K overlay for
  triaging by keyboard.
- **Notifications that tell you something.** Rich notifications per project,
  session, and question — click one to jump straight to that session. Quiet
  while you're already looking at the window.
- **A menu bar quick view.** A tray icon shows how many sessions need you, and
  its popover lets you jump into one without opening the app.
- **Built-in terminals.** A dock plus a full-height view, with tabs, splits
  (⌘D), per-project layout that persists, and an indicator that pulses while
  something is running. It warns before you close a busy one.
- **A prompt library.** Save, tag, search, and insert prompts, with placeholders
  you fill on the way in — and import/promote to `.claude/commands`.
- **Git worktrees and review.** Spawn a follow-up session in its own worktree,
  review its diff and merge it from a panel, then archive it and clean up.
- **Pick up where you left off.** Kriyon scans a folder's earlier Claude
  sessions and resumes one into a live session.
- **Themes.** Four accent themes, self-hosted JetBrains Mono Nerd Font,
  per-project identity colors, and a command palette to switch it all.
- **A signed, notarized macOS app** with proper branding.
