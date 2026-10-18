//! Reading a session's real liveness out of the OS process table.
//!
//! Kriyon's [PTY daemon] deliberately outlives the app: quitting Kriyon leaves
//! `kriyon-ptyd` running so a session's `claude` survives to be reattached. That
//! makes "the daemon process exists" almost useless as a liveness signal — on a
//! working machine dozens of daemons are alive for sessions last touched days
//! ago. The question that actually matters at seed time is narrower:
//!
//! > is a `claude` still running in this session's terminal *right now*?
//!
//! The kernel already answers it. Each daemon hosts one shell as its direct
//! child, and the shell is a session leader (so its pgid equals its pid). Job
//! control moves each foreground command into its own process group, so the
//! PTY's foreground process group id — `tpgid`, the same `tcgetpgrp` state the
//! daemon's own `foreground_busy` reads — is the shell's own pid when the shell
//! sits at its prompt, and the foreground command's pid otherwise.
//!
//! This module is the pure half: parsing a `ps` table and folding it into a
//! verdict. The `ps` invocation itself lives in the Tauri shell.

use std::collections::{HashMap, HashSet};

/// One row of the process table: the fields needed to walk daemon → shell →
/// foreground command. `cmd` is the raw command line, used both to recognize a
/// daemon by the session id it embeds and to recognize `claude` by name.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProcRow {
    pub pid: i32,
    pub ppid: i32,
    /// Foreground process group of the row's controlling terminal, or `-1`
    /// when it has none.
    pub tpgid: i32,
    pub cmd: String,
}

/// What holds a session's PTY foreground.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PtyForeground {
    /// A `claude` process is running in the terminal.
    Claude,
    /// The shell is at its own prompt — whatever the events file last recorded,
    /// no `claude` is running to still be blocked on it.
    ShellPrompt,
    /// The daemon for this session is gone entirely.
    NoDaemon,
    /// Something occupies the foreground, or the table is too incomplete to
    /// walk. Callers that gate on this must fail open: the cost of being wrong
    /// here is hiding a session that genuinely needs the user.
    Unknown,
}

/// Where a `claude` process sits on its controlling terminal: the facts that
/// decide whether it is a [Session]'s [Owning claude].
///
/// Everything Kriyon learns about a session from inside Claude Code (hook
/// events, the status line, the companion's posts) is tied to it by env vars.
/// Every process the session's `claude` starts inherits those, so a `claude`
/// run from a Bash command or a test script looks just like the session's own.
/// The terminal is what tells them apart: only the session's own `claude` holds
/// the foreground of the session's PTY.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TerminalSeat {
    /// The process's own process group.
    pub pgid: i32,
    /// The foreground process group of its controlling terminal; `0` or less
    /// when it has none.
    pub foreground_pgid: i32,
    /// Whether that controlling terminal is the session's PTY.
    pub on_session_tty: bool,
}

impl TerminalSeat {
    /// Whether this process is the session's [Owning claude]: it is on the
    /// session's terminal and in that terminal's foreground group.
    #[must_use]
    pub fn owns_session(&self) -> bool {
        self.on_session_tty && self.foreground_pgid > 0 && self.pgid == self.foreground_pgid
    }
}

/// Parse the output of `ps -axww -o pid=,ppid=,tpgid=,args=`.
///
/// Tolerant by design (the [Loose coupling] rule applies to the OS too): a row
/// whose numeric fields don't parse is skipped rather than failing the sweep, so
/// one odd process can never blind the whole check.
#[must_use]
pub fn parse_ps_rows(text: &str) -> Vec<ProcRow> {
    text.lines().filter_map(parse_ps_row).collect()
}

fn parse_ps_row(line: &str) -> Option<ProcRow> {
    let mut fields = line.split_whitespace();
    // Built field-by-field straight off the iterator: struct fields initialize
    // in written order, so this consumes the three numeric columns in place and
    // leaves the rest for `cmd`. (Naming locals for them instead trips clippy's
    // similar-names lint on the POSIX pair `pid`/`ppid`, which are the right
    // names for these columns.)
    let row = ProcRow {
        pid: fields.next()?.parse().ok()?,
        ppid: fields.next()?.parse().ok()?,
        tpgid: fields.next()?.parse().ok()?,
        // Everything after the numeric columns is the command line. Joining the
        // remainder (rather than reading a fixed column count) keeps command
        // lines containing whitespace intact.
        cmd: fields.collect::<Vec<_>>().join(" "),
    };
    if row.cmd.is_empty() {
        return None;
    }
    Some(row)
}

impl PtyForeground {
    /// How strongly this verdict argues for *keeping* a session's attention
    /// state. Higher wins when several candidate processes disagree: the two
    /// low ranks are the only verdicts that hide a session, so a single
    /// candidate saying "claude is live" must always beat a sibling saying
    /// "idle shell". Wrongly hiding a session that needs the user is the one
    /// outcome this module must never produce.
    const fn rank(self) -> u8 {
        match self {
            Self::Claude => 3,
            Self::Unknown => 2,
            Self::ShellPrompt => 1,
            Self::NoDaemon => 0,
        }
    }
}

/// The `kriyon-ptyd` executable name, matched as the row's argv[0] basename.
const DAEMON_EXECUTABLE: &str = "kriyon-ptyd";

/// Whether a row is a [PTY daemon] process at all — its *executable* (argv[0])
/// is `kriyon-ptyd`, not merely a command line that mentions the string
/// somewhere. `grep kriyon-ptyd …`, an editor opening a daemon log, or a shell
/// wrapper naming it would all pass a substring test and then be mistaken for a
/// daemon; requiring argv[0] rules them out. The one home for "is this a
/// daemon", shared by the sweep index and the per-session socket match so the
/// two can never drift.
fn is_daemon_row(row: &ProcRow) -> bool {
    row.cmd
        .split_whitespace()
        .next()
        .and_then(|exe| exe.rsplit('/').next())
        == Some(DAEMON_EXECUTABLE)
}

/// Whether a process-table row is `session_id`'s [PTY daemon].
///
/// A daemon process (argv[0] is `kriyon-ptyd`) whose socket *argument* is
/// `<id>.sock` as a whole path segment — not a loose substring of its command
/// line. A plain "mentions the session id somewhere" test — what the previous
/// `pgrep -f kriyon-ptyd.*<id>` did — also matches any unrelated command that
/// happens to name both, e.g. a script or an editor with the id in its argv.
fn is_session_daemon(row: &ProcRow, session_id: &str) -> bool {
    if !is_daemon_row(row) {
        return false;
    }
    let socket = format!("{session_id}.sock");
    row.cmd
        .split_whitespace()
        .any(|token| token.rsplit('/').next() == Some(socket.as_str()))
}

/// The session id a [PTY daemon] row serves — but only if its [Session socket]
/// sits directly inside `run_dir`. `None` for anything else: a non-daemon, a
/// daemon whose socket lives elsewhere (a `cargo test` daemon, another tool's),
/// or an id that fails the path-containment check.
///
/// This is the [Orphan daemon] reaper's only way to claim a process as
/// Kriyon's, so it is deliberately strict. It matches the exact argument run
/// `spawn_daemon` writes — `--socket <run_dir>/<id>.sock --id <id>` — as one
/// string rather than re-tokenizing, because a `ps` command line is
/// whitespace-joined and a home directory may contain spaces.
#[must_use]
pub fn daemon_session_id(row: &ProcRow, run_dir: &str) -> Option<String> {
    if !is_daemon_row(row) {
        return None;
    }
    let mut tokens = row.cmd.split_whitespace();
    tokens.find(|token| *token == "--id")?;
    let id = tokens.next()?;
    if !crate::daemon::is_valid_session_id(id) {
        return None;
    }
    let spawned_as = format!("--socket {run_dir}/{id}.sock --id {id}");
    row.cmd.contains(&spawned_as).then(|| id.to_string())
}

/// An indexed view over one `ps` sweep: every question about a session's
/// processes is answered from here.
///
/// Built once per sweep and shared by all callers. The flat row slice it
/// replaces gave callers no leverage — each of them re-derived the same
/// daemon → shell → foreground relationship by scanning every row, so the same
/// walk was written four times and run once per session per question. At the
/// scale this runs at (dozens of sessions, ~1500 rows, every few seconds) that
/// was the most expensive thing on the ticker. Indexing turns each per-session
/// query into a handful of hash lookups and gives the daemon-matching rule
/// exactly one home.
pub struct ProcessTree<'a> {
    rows: &'a [ProcRow],
    index: std::borrow::Cow<'a, ProcessIndex>,
}

/// The index half of a [`ProcessTree`], as positions into the sweep rather than
/// references into it — so it can be built once and *kept* beside the rows it
/// describes.
///
/// The cached table hands out rows, and every caller used to write
/// `ProcessTree::new(&rows)` itself, rebuilding this on each read: the cache
/// saved the `ps` fork and then threw away the more expensive half. One sleep
/// pass alone built it four times.
#[derive(Clone, Debug, Default)]
pub struct ProcessIndex {
    /// First row seen for each pid. First — not last — because the flat walk
    /// resolved pids with `find`, and a garbled sweep repeating a pid must not
    /// change which row wins.
    by_pid: HashMap<i32, usize>,
    /// Direct children per parent pid, in table order.
    children: HashMap<i32, Vec<usize>>,
    /// Every `kriyon-ptyd` row, whatever session it serves. A few dozen at
    /// most, so the per-session socket match scans this instead of the table.
    daemons: Vec<usize>,
}

impl ProcessIndex {
    /// Index one sweep. Linear in the number of rows, once.
    #[must_use]
    pub fn build(rows: &[ProcRow]) -> Self {
        let mut by_pid: HashMap<i32, usize> = HashMap::with_capacity(rows.len());
        let mut children: HashMap<i32, Vec<usize>> = HashMap::new();
        let mut daemons: Vec<usize> = Vec::new();
        for (at, row) in rows.iter().enumerate() {
            by_pid.entry(row.pid).or_insert(at);
            children.entry(row.ppid).or_default().push(at);
            if is_daemon_row(row) {
                daemons.push(at);
            }
        }
        Self {
            by_pid,
            children,
            daemons,
        }
    }
}

impl<'a> ProcessTree<'a> {
    /// Index one sweep and view it. For a caller that holds rows and nothing
    /// else; prefer [`Self::bound`] where the index is already cached.
    #[must_use]
    pub fn new(rows: &'a [ProcRow]) -> Self {
        Self {
            rows,
            index: std::borrow::Cow::Owned(ProcessIndex::build(rows)),
        }
    }

    /// View a sweep through an index already built for *these* rows. Binding
    /// an index to a different sweep would answer every question about the
    /// wrong processes, so the two are only ever paired by whoever cached them
    /// together.
    #[must_use]
    pub fn bound(rows: &'a [ProcRow], index: &'a ProcessIndex) -> Self {
        Self {
            rows,
            index: std::borrow::Cow::Borrowed(index),
        }
    }

    /// The row at `at`, which an index position always addresses.
    fn at(&self, at: usize) -> &'a ProcRow {
        &self.rows[at]
    }

    /// This session's [PTY daemon] rows. More than one is real: `spawn_daemon`
    /// unlinks an unconnectable socket and spawns a replacement without killing
    /// the old one, so a wedged daemon can outlive it.
    fn daemons_of<'s>(&'s self, session_id: &'s str) -> impl Iterator<Item = &'a ProcRow> + 's {
        self.index
            .daemons
            .iter()
            .map(|at| self.at(*at))
            .filter(move |row| is_session_daemon(row, session_id))
    }

    /// The pids of `session_id`'s live [PTY daemon]s. Empty when none is
    /// running — the question `spawn_daemon` must ask before it unlinks a socket
    /// file, because a daemon whose socket was deleted is otherwise orphaned
    /// for good.
    pub fn daemon_pids<'s>(&'s self, session_id: &'s str) -> impl Iterator<Item = i32> + 's {
        self.daemons_of(session_id).map(|row| row.pid)
    }

    /// Direct children of `pid`, in table order.
    fn children_of(&self, pid: i32) -> impl Iterator<Item = &'a ProcRow> + '_ {
        self.index
            .children
            .get(&pid)
            .map_or(&[][..], Vec::as_slice)
            .iter()
            .map(|at| self.at(*at))
    }

    /// The row for `pid`, if the sweep saw it.
    #[must_use]
    pub fn row(&self, pid: i32) -> Option<&'a ProcRow> {
        self.index.by_pid.get(&pid).map(|at| self.at(*at))
    }

    /// Every [PTY daemon] row in the sweep, whatever session it serves.
    pub fn daemons(&self) -> impl Iterator<Item = &'a ProcRow> + '_ {
        self.index.daemons.iter().map(|at| self.at(*at))
    }

    /// Every transitive child of `root`, in discovery order, `root` excluded.
    ///
    /// `setsid()` does not change a process's parent, so a child that detached
    /// into its own session is still found here. A parsed table can repeat or
    /// garble a row, so membership is tracked explicitly: a `ppid` cycle must
    /// terminate the walk, not spin it.
    #[must_use]
    pub fn descendants_of(&self, root: i32) -> Vec<i32> {
        let mut seen: HashSet<i32> = HashSet::from([root]);
        let mut pids: Vec<i32> = Vec::new();
        let mut frontier = vec![root];
        while let Some(parent) = frontier.pop() {
            for child in self.children_of(parent) {
                if seen.insert(child.pid) {
                    pids.push(child.pid);
                    frontier.push(child.pid);
                }
            }
        }
        pids
    }

    /// `pid`'s parent chain, nearest first, `pid` excluded. Stops at a pid the
    /// sweep did not see, at pid 0, or on a cycle.
    #[must_use]
    pub fn ancestors_of(&self, pid: i32) -> Vec<i32> {
        let mut seen: HashSet<i32> = HashSet::from([pid]);
        let mut chain: Vec<i32> = Vec::new();
        let mut cursor = pid;
        while let Some(row) = self.row(cursor) {
            if row.ppid <= 0 || !seen.insert(row.ppid) {
                break;
            }
            chain.push(row.ppid);
            cursor = row.ppid;
        }
        chain
    }

    /// What holds the PTY foreground for `session_id`'s [PTY daemon].
    ///
    /// Walks daemon → shell child → the shell's terminal foreground group. The
    /// interesting verdict is [`PtyForeground::ShellPrompt`]: the shell owning
    /// its own terminal foreground is positive evidence that no `claude` is
    /// running, so a replayed "waiting on you" from that session's history is
    /// stale.
    ///
    /// Every matching daemon and every direct child is considered, and the most
    /// attention-preserving verdict wins. Taking the first match would let a
    /// wedged daemon's idle shell report `ShellPrompt` and hide the live
    /// daemon's genuinely blocked `claude`.
    #[must_use]
    pub fn foreground(&self, session_id: &str) -> PtyForeground {
        let mut saw_daemon = false;
        let mut best: Option<PtyForeground> = None;
        for daemon in self.daemons_of(session_id) {
            saw_daemon = true;
            // Any direct child is a candidate shell; a daemon hosts one, but a
            // transient fork must not be mistaken for the only answer.
            for shell in self.children_of(daemon.pid) {
                let candidate = self.shell_foreground(shell);
                if best.is_none_or(|current| candidate.rank() > current.rank()) {
                    best = Some(candidate);
                }
            }
        }
        match (saw_daemon, best) {
            (false, _) => PtyForeground::NoDaemon,
            // The daemon is right there in the table but its shell isn't
            // visible — that rules out NoDaemon without licensing any positive
            // claim.
            (true, None) => PtyForeground::Unknown,
            (true, Some(verdict)) => verdict,
        }
    }

    /// The pid of the `claude` currently holding `session_id`'s terminal
    /// foreground, or `None` when no claude visibly holds it. The precise
    /// target for a [Sleeping session]'s stop signal: never the shell, never
    /// the process group.
    #[must_use]
    pub fn claude_pid(&self, session_id: &str) -> Option<i32> {
        for daemon in self.daemons_of(session_id) {
            for shell in self.children_of(daemon.pid) {
                let Some(foreground) = self.shell_foreground_row(shell) else {
                    continue;
                };
                if looks_like_claude(&foreground.cmd) {
                    return Some(foreground.pid);
                }
            }
        }
        None
    }

    /// Every pid in `session_id`'s tree: its daemon(s) plus all transitive
    /// children, in discovery order. The daemon is the root, so everything a
    /// session costs (shell, `claude`, MCP servers, spawned dev servers)
    /// descends from it.
    ///
    /// A parsed table can repeat or garble a row, so membership is tracked
    /// explicitly: a `ppid` cycle must terminate the walk, not spin it.
    #[must_use]
    pub fn tree_pids(&self, session_id: &str) -> Vec<i32> {
        let mut pids: Vec<i32> = Vec::new();
        let mut seen: HashSet<i32> = HashSet::new();
        for daemon in self.daemons_of(session_id) {
            if seen.insert(daemon.pid) {
                pids.push(daemon.pid);
            }
        }
        let mut cursor = 0;
        while cursor < pids.len() {
            let parent = pids[cursor];
            cursor += 1;
            for child in self.children_of(parent) {
                if seen.insert(child.pid) {
                    pids.push(child.pid);
                }
            }
        }
        pids
    }

    /// The row occupying `shell`'s terminal foreground, or `None` when the
    /// shell sits at its own prompt, has no controlling terminal, or the
    /// foreground process is missing from the table.
    fn shell_foreground_row(&self, shell: &ProcRow) -> Option<&'a ProcRow> {
        if shell.tpgid <= 0 || shell.tpgid == shell.pid {
            return None;
        }
        self.row(shell.tpgid)
    }

    /// The foreground verdict for one candidate shell row.
    fn shell_foreground(&self, shell: &ProcRow) -> PtyForeground {
        if shell.tpgid <= 0 {
            // No controlling terminal recorded — nothing can be concluded.
            return PtyForeground::Unknown;
        }
        if shell.tpgid == shell.pid {
            return PtyForeground::ShellPrompt;
        }
        match self.shell_foreground_row(shell) {
            Some(foreground) if looks_like_claude(&foreground.cmd) => PtyForeground::Claude,
            // A foreground command that isn't claude (the user ran `vim`, say),
            // or one missing from the table. Deliberately Unknown rather than a
            // negative: claude may have handed the terminal to a child, and
            // wrongly calling that "not blocked" would hide a real ask.
            _ => PtyForeground::Unknown,
        }
    }
}

/// Whether a session's replayed attention state (Waiting / open ask) should
/// still be trusted, given what holds its terminal. The single place the
/// verdict becomes a yes/no, so the polarity is unit-testable rather than
/// living only in a `!matches!` at the call site.
#[must_use]
pub const fn may_still_be_blocked(foreground: PtyForeground) -> bool {
    match foreground {
        // Positive evidence no claude is running: nothing can still be blocked.
        PtyForeground::ShellPrompt | PtyForeground::NoDaemon => false,
        PtyForeground::Claude | PtyForeground::Unknown => true,
    }
}

/// Whether a command line launches `claude`. Matches any argument with a path
/// segment of exactly `claude`, so a bare `claude`, an absolute
/// `/opt/homebrew/bin/claude`, and a node-wrapped `…/share/claude/cli.js` all
/// read alike. Matching whole segments (not a substring) is what keeps
/// `claudette` and a `~/.claude/…` file path from reading as the process.
///
/// Deliberately generous: a false positive only means the seed gate stays as
/// permissive as it was before the gate existed, while a false negative would
/// hide a session that genuinely needs the user.
fn looks_like_claude(cmd: &str) -> bool {
    cmd.split_whitespace()
        .flat_map(|token| token.split('/'))
        .any(|segment| segment == "claude")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn seat(pgid: i32, foreground_pgid: i32, on_session_tty: bool) -> TerminalSeat {
        TerminalSeat {
            pgid,
            foreground_pgid,
            on_session_tty,
        }
    }

    #[test]
    fn the_claude_leading_the_session_foreground_owns_it() {
        assert!(seat(3000, 3000, true).owns_session());
    }

    #[test]
    fn a_claude_started_from_a_tool_command_does_not_own_the_session() {
        // Claude Code runs each Bash command in a new session with no terminal:
        // a nested `claude -p` there has no foreground group at all.
        assert!(!seat(4000, 0, false).owns_session());
        assert!(!seat(4000, -1, false).owns_session());
    }

    #[test]
    fn a_claude_in_its_own_terminal_does_not_own_the_session() {
        // A test script that opens a pty for a nested `claude` makes it the
        // foreground there, just not on the session's terminal.
        assert!(!seat(5000, 5000, false).owns_session());
    }

    #[test]
    fn a_claude_behind_the_session_foreground_does_not_own_it() {
        // On the session's terminal but in a background group (`claude &`, or
        // a child sharing the terminal while another job holds it).
        assert!(!seat(6000, 3000, true).owns_session());
    }

    /// A daemon (pid 100) hosting a shell (pid 200). `tpgid` says what the
    /// shell's terminal foreground is; `fg` optionally adds that process.
    fn table(tpgid: i32, fg: Option<(i32, &str)>) -> Vec<ProcRow> {
        let mut rows = vec![
            ProcRow {
                pid: 100,
                ppid: 1,
                tpgid: -1,
                cmd: "/Applications/Kriyon.app/…/kriyon-ptyd /Users/x/.claude/kriyon/run/sess-abc.sock".into(),
            },
            ProcRow {
                pid: 200,
                ppid: 100,
                tpgid,
                cmd: "/bin/zsh -l".into(),
            },
        ];
        if let Some((pid, cmd)) = fg {
            rows.push(ProcRow {
                pid,
                ppid: 200,
                tpgid,
                cmd: cmd.into(),
            });
        }
        rows
    }

    #[test]
    fn a_shell_at_its_own_prompt_means_claude_is_gone() {
        // The bug this module exists for: the daemon is alive (it outlives the
        // app by design) but nothing runs in it, so a replayed "waiting" is stale.
        assert_eq!(
            ProcessTree::new(&table(200, None)).foreground("sess-abc"),
            PtyForeground::ShellPrompt
        );
    }

    #[test]
    fn a_live_claude_in_the_foreground_is_recognized() {
        assert_eq!(
            ProcessTree::new(&table(3000, Some((3000, "claude")))).foreground("sess-abc"),
            PtyForeground::Claude
        );
    }

    #[test]
    fn claude_is_recognized_however_it_was_launched() {
        for cmd in [
            "claude",
            "/opt/homebrew/bin/claude --resume",
            "node /Users/x/.local/share/claude/cli.js",
            "/usr/bin/node /opt/claude",
        ] {
            assert!(looks_like_claude(cmd), "{cmd} should read as claude");
        }
        for cmd in ["/bin/zsh -l", "vim ~/.claude/settings.json", "claudette"] {
            assert!(!looks_like_claude(cmd), "{cmd} should not read as claude");
        }
    }

    #[test]
    fn a_missing_daemon_is_reported_as_such() {
        assert_eq!(
            ProcessTree::new(&table(200, None)).foreground("some-other-session"),
            PtyForeground::NoDaemon
        );
    }

    #[test]
    fn an_unrelated_process_naming_the_session_is_not_its_daemon() {
        // Caught in live testing: any command line that merely mentions both
        // "kriyon-ptyd" and the session id — a script, an editor, a grep — was
        // enough to be mistaken for the daemon under a substring match, which
        // then reported a bogus foreground for a session with no daemon at all.
        let rows = vec![ProcRow {
            pid: 900,
            ppid: 1,
            tpgid: -1,
            cmd: "/bin/zsh -c 'grep kriyon-ptyd ~/logs/sess-abc.sock.log'".into(),
        }];
        assert_eq!(
            ProcessTree::new(&rows).foreground("sess-abc"),
            PtyForeground::NoDaemon
        );
    }

    #[test]
    fn an_impostor_naming_the_exact_socket_is_not_a_daemon() {
        // A single-line collision the `.sock.log` case above does not cover: a
        // command whose argv holds the *exact* `<id>.sock` token AND the string
        // "kriyon-ptyd" — e.g. `cat` on the socket, or a wrapper — passes a
        // substring test. Requiring argv[0] to be the daemon executable rules
        // it out, so it can neither report a foreground nor be charged memory.
        let rows = vec![ProcRow {
            pid: 900,
            ppid: 1,
            tpgid: -1,
            cmd: "/bin/cat kriyon-ptyd /Users/x/.claude/kriyon/run/sess-abc.sock".into(),
        }];
        assert_eq!(
            ProcessTree::new(&rows).foreground("sess-abc"),
            PtyForeground::NoDaemon
        );
        assert_eq!(
            ProcessTree::new(&rows).tree_pids("sess-abc"),
            [] as [i32; 0]
        );
    }

    #[test]
    fn an_unrecognized_foreground_command_stays_unknown() {
        // claude may hand the terminal to a child; calling that "not blocked"
        // would hide a real ask, so this must never be a negative verdict.
        assert_eq!(
            ProcessTree::new(&table(4000, Some((4000, "vim notes.md")))).foreground("sess-abc"),
            PtyForeground::Unknown
        );
    }

    #[test]
    fn a_stale_duplicate_daemon_cannot_hide_the_live_ones_claude() {
        // `spawn_daemon` unlinks an unconnectable socket and spawns a fresh
        // daemon without killing the old one, so two daemons can hold the same
        // session id. Taking the first match let the corpse's idle shell report
        // ShellPrompt and hide the live daemon's genuinely blocked claude.
        let mut rows = table(200, None); // stale: daemon 100, shell 200 at prompt
        rows.push(ProcRow {
            pid: 300,
            ppid: 1,
            tpgid: -1,
            cmd: "/Applications/Kriyon.app/…/kriyon-ptyd /Users/x/.claude/kriyon/run/sess-abc.sock"
                .into(),
        });
        rows.push(ProcRow {
            pid: 400,
            ppid: 300,
            tpgid: 500,
            cmd: "/bin/zsh -l".into(),
        });
        rows.push(ProcRow {
            pid: 500,
            ppid: 400,
            tpgid: 500,
            cmd: "claude --resume".into(),
        });

        assert_eq!(
            ProcessTree::new(&rows).foreground("sess-abc"),
            PtyForeground::Claude
        );
    }

    #[test]
    fn only_positive_evidence_of_no_claude_drops_a_replayed_state() {
        // Pins the gate's polarity in the one place it is decided. Flipping it
        // would either hide every blocked session or restore the useless
        // always-true check it replaced.
        assert!(may_still_be_blocked(PtyForeground::Claude));
        assert!(may_still_be_blocked(PtyForeground::Unknown));
        assert!(!may_still_be_blocked(PtyForeground::ShellPrompt));
        assert!(!may_still_be_blocked(PtyForeground::NoDaemon));
    }

    /// The cached survey builds the index once and binds it on every read, so
    /// a bound view must answer exactly as a freshly-indexed one does.
    #[test]
    fn a_bound_index_answers_the_same_as_a_freshly_built_one() {
        let rows = table(3000, Some((3000, "claude --resume")));
        let index = ProcessIndex::build(&rows);
        let bound = ProcessTree::bound(&rows, &index);
        let built = ProcessTree::new(&rows);

        assert_eq!(bound.claude_pid("sess-abc"), built.claude_pid("sess-abc"));
        assert_eq!(bound.foreground("sess-abc"), built.foreground("sess-abc"));
        assert_eq!(bound.tree_pids("sess-abc"), built.tree_pids("sess-abc"));
        assert_eq!(
            bound.daemon_pids("sess-abc").collect::<Vec<_>>(),
            built.daemon_pids("sess-abc").collect::<Vec<_>>()
        );
        assert_eq!(
            bound.row(200).map(|row| &row.cmd),
            built.row(200).map(|row| &row.cmd)
        );
        assert_eq!(bound.daemons().count(), built.daemons().count());
    }

    #[test]
    fn claude_pid_targets_exactly_the_foreground_claude() {
        assert_eq!(
            ProcessTree::new(&table(3000, Some((3000, "claude --resume")))).claude_pid("sess-abc"),
            Some(3000)
        );
        // Shell at prompt, non-claude foreground, missing daemon: no target.
        assert_eq!(
            ProcessTree::new(&table(200, None)).claude_pid("sess-abc"),
            None
        );
        assert_eq!(
            ProcessTree::new(&table(4000, Some((4000, "vim notes.md")))).claude_pid("sess-abc"),
            None
        );
        assert_eq!(
            ProcessTree::new(&table(200, None)).claude_pid("other-session"),
            None
        );
    }

    #[test]
    fn an_incomplete_table_stays_unknown() {
        // Shell missing entirely, and a shell with no controlling terminal.
        let daemon_only = vec![table(200, None)[0].clone()];
        assert_eq!(
            ProcessTree::new(&daemon_only).foreground("sess-abc"),
            PtyForeground::Unknown
        );
        assert_eq!(
            ProcessTree::new(&table(-1, None)).foreground("sess-abc"),
            PtyForeground::Unknown
        );
    }

    #[test]
    fn the_index_answers_every_query_the_flat_walk_did() {
        // The index is the interface now: one build, three answers. These pin
        // that indexing changed nothing about the verdicts.
        let rows = table(3000, Some((3000, "claude --resume")));
        let tree = ProcessTree::new(&rows);
        assert_eq!(tree.foreground("sess-abc"), PtyForeground::Claude);
        assert_eq!(tree.claude_pid("sess-abc"), Some(3000));
        assert_eq!(tree.tree_pids("sess-abc"), vec![100, 200, 3000]);
    }

    #[test]
    fn the_index_keeps_the_first_row_for_a_duplicated_pid() {
        // `find`-by-pid took the first matching row; a HashMap would take the
        // last. A garbled sweep must not change which row wins.
        let rows = vec![
            ProcRow {
                pid: 100,
                ppid: 1,
                tpgid: -1,
                cmd: "/bin/kriyon-ptyd /x/sess-abc.sock".into(),
            },
            ProcRow {
                pid: 200,
                ppid: 100,
                tpgid: 300,
                cmd: "/bin/zsh -l".into(),
            },
            ProcRow {
                pid: 300,
                ppid: 200,
                tpgid: 300,
                cmd: "claude".into(),
            },
            ProcRow {
                pid: 300,
                ppid: 200,
                tpgid: 300,
                cmd: "vim notes.md".into(),
            },
        ];
        let tree = ProcessTree::new(&rows);
        assert_eq!(tree.foreground("sess-abc"), PtyForeground::Claude);
    }

    #[test]
    fn tree_pids_collect_the_daemon_and_all_descendants() {
        let rows = vec![
            ProcRow {
                pid: 100,
                ppid: 1,
                tpgid: -1,
                cmd: "kriyon-ptyd /Users/x/.claude/kriyon/run/sess-a.sock".into(),
            },
            ProcRow {
                pid: 200,
                ppid: 100,
                tpgid: 200,
                cmd: "/bin/zsh -l".into(),
            },
            ProcRow {
                pid: 300,
                ppid: 200,
                tpgid: 300,
                cmd: "claude --resume".into(),
            },
            ProcRow {
                pid: 310,
                ppid: 300,
                tpgid: 300,
                cmd: "npm exec context7-mcp".into(),
            },
            // A different session's tree, and an impostor naming the id.
            ProcRow {
                pid: 400,
                ppid: 1,
                tpgid: -1,
                cmd: "kriyon-ptyd /Users/x/.claude/kriyon/run/sess-b.sock".into(),
            },
            ProcRow {
                pid: 410,
                ppid: 400,
                tpgid: 410,
                cmd: "/bin/zsh -l".into(),
            },
            ProcRow {
                pid: 900,
                ppid: 1,
                tpgid: -1,
                cmd: "grep sess-a.sock /tmp/log".into(),
            },
        ];
        let tree = ProcessTree::new(&rows);
        assert_eq!(tree.tree_pids("sess-a"), vec![100, 200, 300, 310]);
        assert_eq!(tree.tree_pids("sess-b"), vec![400, 410]);
        assert_eq!(tree.tree_pids("sess-zzz"), [] as [i32; 0]);
    }

    #[test]
    fn a_pid_cycle_cannot_hang_the_tree_walk() {
        // ppid cycles can't happen in a real table, but the sweep is parsed
        // text — a duplicate/garbled row must terminate, not spin.
        let rows = vec![
            ProcRow {
                pid: 100,
                ppid: 1,
                tpgid: -1,
                cmd: "kriyon-ptyd /x/sess-a.sock".into(),
            },
            ProcRow {
                pid: 200,
                ppid: 100,
                tpgid: 200,
                cmd: "/bin/zsh".into(),
            },
            ProcRow {
                pid: 100,
                ppid: 200,
                tpgid: -1,
                cmd: "kriyon-ptyd /x/sess-a.sock".into(),
            },
        ];
        assert_eq!(ProcessTree::new(&rows).tree_pids("sess-a"), vec![100, 200]);
    }

    #[test]
    fn ps_rows_parse_with_command_lines_containing_spaces() {
        let rows = parse_ps_rows(
            "  100     1    -1 /bin/kriyon-ptyd /Users/x/run/a b.sock\n\
             \x20 200   100   200 /bin/zsh -l\n\
             garbage line\n\
             \x20 abc   100   200 /bin/bad\n",
        );
        assert_eq!(rows.len(), 2, "unparseable rows are skipped, not fatal");
        assert_eq!(rows[0].pid, 100);
        assert_eq!(rows[0].tpgid, -1);
        assert_eq!(rows[0].cmd, "/bin/kriyon-ptyd /Users/x/run/a b.sock");
        assert_eq!(rows[1].ppid, 100);
    }

    fn proc(pid: i32, parent: i32, cmd: &str) -> ProcRow {
        ProcRow {
            pid,
            ppid: parent,
            tpgid: -1,
            cmd: cmd.into(),
        }
    }

    #[test]
    fn descendants_are_transitive_and_exclude_the_root() {
        let rows = vec![
            proc(100, 1, "kriyon-ptyd"),
            proc(200, 100, "/bin/zsh -l"),
            proc(300, 200, "claude"),
            proc(400, 300, "node mcp-server.js"),
            proc(999, 1, "unrelated"),
        ];
        let mut pids = ProcessTree::new(&rows).descendants_of(100);
        pids.sort_unstable();
        assert_eq!(pids, vec![200, 300, 400]);
    }

    #[test]
    fn a_ppid_cycle_terminates_the_descendant_walk() {
        let rows = vec![proc(100, 200, "a"), proc(200, 100, "b")];
        assert_eq!(ProcessTree::new(&rows).descendants_of(100), vec![200]);
    }

    #[test]
    fn ancestors_run_nearest_first_up_to_launchd() {
        let rows = vec![
            proc(1, 0, "/sbin/launchd"),
            proc(50, 1, "Kriyon"),
            proc(100, 50, "kriyon-ptyd"),
        ];
        let tree = ProcessTree::new(&rows);
        assert_eq!(tree.ancestors_of(100), vec![50, 1]);
        assert_eq!(tree.ancestors_of(424_242), Vec::<i32>::new());
    }

    #[test]
    fn a_ppid_cycle_terminates_the_ancestor_walk() {
        let rows = vec![proc(100, 200, "a"), proc(200, 100, "b")];
        assert_eq!(ProcessTree::new(&rows).ancestors_of(100), vec![200]);
    }

    const RUN_DIR: &str = "/Users/x/.claude/kriyon/run";

    fn daemon_cmd(socket_dir: &str, id: &str) -> String {
        format!(
            "/Applications/Kriyon.app/Contents/MacOS/kriyon-ptyd --socket {socket_dir}/{id}.sock \
             --id {id} --cwd /Users/x/my project --shell /bin/zsh"
        )
    }

    #[test]
    fn a_daemon_in_the_run_dir_yields_its_session_id() {
        let row = proc(100, 1, &daemon_cmd(RUN_DIR, "0e8f9a2b-1c3d"));
        assert_eq!(
            daemon_session_id(&row, RUN_DIR).as_deref(),
            Some("0e8f9a2b-1c3d")
        );
    }

    #[test]
    fn a_run_dir_containing_spaces_still_matches() {
        let run_dir = "/Users/first last/.claude/kriyon/run";
        let row = proc(100, 1, &daemon_cmd(run_dir, "abc-123"));
        assert_eq!(daemon_session_id(&row, run_dir).as_deref(), Some("abc-123"));
    }

    #[test]
    fn a_daemon_outside_the_run_dir_is_never_claimed() {
        // A `cargo test` daemon, or another tool's: its socket lives elsewhere,
        // so the reaper must not see it as Kriyon's to stop.
        let row = proc(100, 1, &daemon_cmd("/var/folders/tmp123", "abc-123"));
        assert_eq!(daemon_session_id(&row, RUN_DIR), None);
        // A sibling directory that merely shares the run dir's prefix.
        let row = proc(
            100,
            1,
            &daemon_cmd("/Users/x/.claude/kriyon/run-evil", "abc-123"),
        );
        assert_eq!(daemon_session_id(&row, RUN_DIR), None);
    }

    #[test]
    fn a_non_daemon_or_a_malformed_id_yields_nothing() {
        let grep = proc(100, 1, &format!("grep {}", daemon_cmd(RUN_DIR, "abc-123")));
        assert_eq!(daemon_session_id(&grep, RUN_DIR), None);
        let traversal = proc(
            100,
            1,
            &format!("kriyon-ptyd --socket {RUN_DIR}/../x.sock --id ../x"),
        );
        assert_eq!(daemon_session_id(&traversal, RUN_DIR), None);
        let no_id = proc(100, 1, &format!("kriyon-ptyd --socket {RUN_DIR}/abc.sock"));
        assert_eq!(daemon_session_id(&no_id, RUN_DIR), None);
    }
}
