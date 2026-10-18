//! Pure parsers for `git status --porcelain=v2 --branch` and `git diff`. No
//! process spawning or IO lives here.

use serde::{Deserialize, Serialize};

use crate::transcript::{DiffKind, DiffLine};

/// Summary of `git status --porcelain=v2 --branch` for one repository.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoStatus {
    pub branch: String,
    pub ahead: u32,
    pub behind: u32,
    pub dirty_count: u32,
}

/// How a file changed in a [`FileDiff`].
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FileChange {
    Added,
    Modified,
    Deleted,
    Renamed,
}

/// One `@@ … @@` region of a [`FileDiff`].
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct DiffHunk {
    pub header: String,
    pub lines: Vec<DiffLine>,
}

/// One file's change within a [`SessionDiff`].
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileDiff {
    pub path: String,
    pub old_path: Option<String>,
    pub status: FileChange,
    pub hunks: Vec<DiffHunk>,
    pub binary: bool,
}

/// Why a [Working-tree budget] refused to compute the untracked half of a
/// [`SessionDiff`], and what to gitignore to get it back.
///
/// `untracked_files` is a floor, not an exact census: the enumeration stops as
/// soon as it knows the ceiling is passed, precisely so a pathological tree
/// isn't fully walked just to produce a number nobody acts on. Read it as "at
/// least this many".
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BudgetExceeded {
    /// How many untracked paths were seen before the enumeration stopped —
    /// always `> file_limit`, and always a lower bound on the true count.
    pub untracked_files: usize,
    /// The ceiling that was passed (`MAX_UNTRACKED_FILES`), so the UI can state
    /// the rule rather than a bare "too many".
    pub file_limit: usize,
    /// The wholly-untracked directories git collapsed the tree into (`opt/`,
    /// `vendor/sdk/`) — the actionable part: these are what to gitignore.
    ///
    /// A prefix of git's own (sorted) listing, capped — deliberately NOT ranked
    /// by size. Ranking would mean walking the very tree that was too big to
    /// walk. Named for what it is so no caller presents it as "the biggest
    /// offenders"; it is a sample. Best-effort and possibly empty.
    pub untracked_dirs: Vec<String>,
}

/// The committed changes a session made on its branch versus `base`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionDiff {
    pub base: String,
    /// Short sha (e.g. `git rev-parse --short <base>`) that `base` resolved to
    /// at diff time, for a trustworthy baseline label ("main @ abc1234"). Left
    /// `None` when resolution wasn't attempted or failed — the label then
    /// falls back to the base name alone. `#[serde(default)]` keeps older
    /// stored JSON (from before this field existed) deserializable.
    #[serde(default)]
    pub base_sha: Option<String>,
    pub files: Vec<FileDiff>,
    /// Set when the [Working-tree budget]'s file ceiling was passed: the
    /// untracked half of this diff was skipped, `files` holds the tracked
    /// changes only. `None` on every ordinary diff.
    #[serde(default)]
    pub budget_exceeded: Option<BudgetExceeded>,
    /// How many untracked files were enumerated but contributed no content:
    /// binary, over the per-file cap, past the budget's byte ceiling, not valid
    /// UTF-8, or not a regular file (an untracked symlink is never followed).
    /// Reported rather than silently dropped, so a review surface never claims
    /// completeness it doesn't have.
    #[serde(default)]
    pub omitted_untracked: usize,
}

/// Synthesize a [`FileDiff`] for an untracked file, treating its whole content
/// as added. Yields no hunks for empty content.
#[must_use]
pub fn untracked_as_diff(path: &str, content: &str) -> FileDiff {
    let lines: Vec<DiffLine> = content
        .lines()
        .map(|text| DiffLine {
            kind: DiffKind::Added,
            text: text.to_string(),
        })
        .collect();
    let hunks = if lines.is_empty() {
        Vec::new()
    } else {
        vec![DiffHunk {
            header: format!("@@ -0,0 +1,{} @@", lines.len()),
            lines,
        }]
    };
    FileDiff {
        path: path.to_string(),
        old_path: None,
        status: FileChange::Added,
        hunks,
        binary: false,
    }
}

/// Which untracked files a [Working-tree budget]'s byte ceiling admits, and how
/// many it turns away.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct UntrackedPlan {
    /// Paths whose content fits, in the order given.
    pub read: Vec<String>,
    /// Paths turned away on size alone. The caller adds to this the ones it
    /// discovers only by reading (binary, non-UTF-8, not a regular file).
    pub omitted: usize,
}

/// Decide which untracked files fit the budget, from their sizes alone.
///
/// Split out of the shell so the arithmetic that actually bounds the IPC
/// payload is testable without a git repo on disk: the boundary cases (a file
/// sized exactly to the remaining budget, one byte over, a single file past the
/// per-file cap) are the ones worth pinning, and reaching them through a real
/// repo means writing real files of exact sizes.
///
/// `per_file_max` caps a single entry — one large log must not fill the whole
/// budget — and `total_max` caps the sum. Entries are considered in the order
/// given, which is git's sorted order: a tree near the ceiling therefore spends
/// its budget alphabetically, which is arbitrary rather than useful, and is why
/// the caller reports what it dropped instead of hiding it.
#[must_use]
pub fn plan_untracked_reads(
    sized: &[(String, u64)],
    per_file_max: u64,
    total_max: u64,
) -> UntrackedPlan {
    let mut read = Vec::new();
    let mut omitted = 0usize;
    let mut remaining = total_max;
    for (path, size) in sized {
        if *size > per_file_max || *size > remaining {
            omitted += 1;
            continue;
        }
        remaining -= *size;
        read.push(path.clone());
    }
    UntrackedPlan { read, omitted }
}

/// Split the NUL-terminated output of a `-z` git listing (`git ls-files
/// --others -z`) into paths.
///
/// `-z` is the reason this is four lines rather than the C-quote decoder it
/// replaced: without it, `git` wraps any path containing a space in double
/// quotes and (under the default `core.quotepath`) octal-escapes every
/// non-ASCII byte, so `café.txt` arrives as `"caf\303\251.txt"` and has to be
/// decoded back. With `-z` the bytes are the path. NUL cannot occur inside a
/// path on any platform Kriyon runs on, so the split is unambiguous.
///
/// Tolerant by design, like every parser in this module: a path that isn't
/// valid UTF-8 (git permits arbitrary bytes) is skipped rather than erroring,
/// and the trailing empty slice left by the final terminator is dropped.
#[must_use]
pub fn parse_nul_paths(raw: &[u8]) -> Vec<String> {
    raw.split(|byte| *byte == 0)
        .filter(|entry| !entry.is_empty())
        .filter_map(|entry| std::str::from_utf8(entry).ok().map(str::to_string))
        .collect()
}

/// Result of merging a session's branch into the base checkout.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum MergeOutcome {
    Clean,
    Conflicted { files: Vec<String> },
}

/// Parse `git diff` output into [`FileDiff`]s.
///
/// Tolerant by design: a `diff --git` line opens a file; `new file` / `deleted
/// file` / `rename from|to` set its status; `@@ … @@` opens a hunk; `+`/`-`/` `
/// classify lines. Binary files yield a [`FileDiff`] with no hunks, and any
/// unexpected line is skipped — it never panics.
#[must_use]
pub fn parse_diff(diff: &str) -> Vec<FileDiff> {
    let mut files: Vec<FileDiff> = Vec::new();
    let mut cur: Option<FileDiff> = None;
    let mut hunk: Option<DiffHunk> = None;

    for raw in diff.lines() {
        let line = raw.trim_end_matches('\r');
        if let Some(rest) = line.strip_prefix("diff --git ") {
            // A new file block starts; flush the in-progress hunk + file first.
            if let Some(file) = cur.as_mut() {
                if let Some(h) = hunk.take() {
                    file.hunks.push(h);
                }
            }
            if let Some(file) = cur.take() {
                files.push(file);
            }
            // "a/<path> b/<path>" — take the b/ side as the path.
            let path = rest
                .split(" b/")
                .nth(1)
                .map_or_else(|| rest.to_string(), str::to_string);
            cur = Some(FileDiff {
                path,
                old_path: None,
                status: FileChange::Modified,
                hunks: Vec::new(),
                binary: false,
            });
        } else if let Some(file) = cur.as_mut() {
            if line.starts_with("new file") {
                file.status = FileChange::Added;
            } else if line.starts_with("deleted file") {
                file.status = FileChange::Deleted;
            } else if let Some(from) = line.strip_prefix("rename from ") {
                file.status = FileChange::Renamed;
                file.old_path = Some(from.to_string());
            } else if let Some(to) = line.strip_prefix("rename to ") {
                file.status = FileChange::Renamed;
                file.path = to.to_string();
            } else if line.starts_with("Binary files ") {
                file.binary = true;
            } else if line.starts_with("@@") {
                if let Some(h) = hunk.take() {
                    file.hunks.push(h);
                }
                // Header is everything up to and including the second "@@".
                let header = line
                    .match_indices("@@")
                    .nth(1)
                    .map_or(line, |(i, _)| &line[..i + 2])
                    .to_string();
                hunk = Some(DiffHunk {
                    header,
                    lines: Vec::new(),
                });
            } else if let Some(h) = hunk.as_mut() {
                let (kind, text) = match line.as_bytes().first() {
                    Some(b'+') => (DiffKind::Added, &line[1..]),
                    Some(b'-') => (DiffKind::Removed, &line[1..]),
                    Some(b' ') => (DiffKind::Context, &line[1..]),
                    // "\ No newline at end of file" and blanks: skip.
                    _ => continue,
                };
                h.lines.push(DiffLine {
                    kind,
                    text: text.to_string(),
                });
            }
        }
    }
    if let Some(file) = cur.as_mut() {
        if let Some(h) = hunk.take() {
            file.hunks.push(h);
        }
    }
    if let Some(file) = cur.take() {
        files.push(file);
    }
    files
}

/// Parse the output of `git status --porcelain=v2 --branch` into a [`RepoStatus`].
///
/// `branch` comes from `# branch.head` (empty string if absent). `ahead`/`behind`
/// come from `# branch.ab +A -B` (both `0` if the line is absent). `dirty_count`
/// counts file lines starting with `1 `, `2 `, `u `, or `? `; ignored (`! `) and
/// header (`# `) lines are not counted. Tolerates `\r` and blank lines.
#[must_use]
pub fn parse_status(porcelain_v2_branch: &str) -> RepoStatus {
    let mut branch = String::new();
    let mut ahead = 0u32;
    let mut behind = 0u32;
    let mut dirty_count = 0u32;

    for raw_line in porcelain_v2_branch.lines() {
        let line = raw_line.trim_end_matches('\r');
        if line.is_empty() {
            continue;
        }

        if let Some(value) = line.strip_prefix("# branch.head ") {
            branch = value.to_string();
        } else if let Some(value) = line.strip_prefix("# branch.ab ") {
            for token in value.split_whitespace() {
                if let Some(num) = token.strip_prefix('+') {
                    ahead = num.parse().unwrap_or(0);
                } else if let Some(num) = token.strip_prefix('-') {
                    behind = num.parse().unwrap_or(0);
                }
            }
        } else if line.starts_with("1 ")
            || line.starts_with("2 ")
            || line.starts_with("u ")
            || line.starts_with("? ")
        {
            dirty_count += 1;
        }
    }

    RepoStatus {
        branch,
        ahead,
        behind,
        dirty_count,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_diff_modified_file_with_hunk() {
        let input = "\
diff --git a/src/main.rs b/src/main.rs
index 1111111..2222222 100644
--- a/src/main.rs
+++ b/src/main.rs
@@ -1,3 +1,3 @@
 fn main() {
-    println!(\"old\");
+    println!(\"new\");
 }
";
        let files = parse_diff(input);
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].path, "src/main.rs");
        assert_eq!(files[0].status, FileChange::Modified);
        assert_eq!(files[0].old_path, None);
        assert_eq!(files[0].hunks.len(), 1);
        assert_eq!(files[0].hunks[0].header, "@@ -1,3 +1,3 @@");
        let kinds: Vec<DiffKind> = files[0].hunks[0].lines.iter().map(|l| l.kind).collect();
        assert_eq!(
            kinds,
            vec![
                DiffKind::Context,
                DiffKind::Removed,
                DiffKind::Added,
                DiffKind::Context
            ]
        );
    }

    #[test]
    fn parse_diff_added_and_deleted_files() {
        let input = "\
diff --git a/new.txt b/new.txt
new file mode 100644
index 0000000..3333333
--- /dev/null
+++ b/new.txt
@@ -0,0 +1,1 @@
+hello
diff --git a/gone.txt b/gone.txt
deleted file mode 100644
index 4444444..0000000
--- a/gone.txt
+++ /dev/null
@@ -1,1 +0,0 @@
-bye
";
        let files = parse_diff(input);
        assert_eq!(files.len(), 2);
        assert_eq!(files[0].status, FileChange::Added);
        assert_eq!(files[0].path, "new.txt");
        assert_eq!(files[1].status, FileChange::Deleted);
        assert_eq!(files[1].path, "gone.txt");
    }

    #[test]
    fn parse_diff_rename_sets_old_path() {
        let input = "\
diff --git a/old/name.rs b/new/name.rs
similarity index 90%
rename from old/name.rs
rename to new/name.rs
index 5555555..6666666 100644
--- a/old/name.rs
+++ b/new/name.rs
@@ -1,1 +1,1 @@
-a
+b
";
        let files = parse_diff(input);
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].status, FileChange::Renamed);
        assert_eq!(files[0].old_path.as_deref(), Some("old/name.rs"));
        assert_eq!(files[0].path, "new/name.rs");
    }

    #[test]
    fn parse_diff_binary_file_has_no_hunks() {
        let input = "\
diff --git a/img.png b/img.png
new file mode 100644
index 0000000..7777777
Binary files /dev/null and b/img.png differ
";
        let files = parse_diff(input);
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].path, "img.png");
        assert_eq!(files[0].status, FileChange::Added);
        assert_eq!(files[0].hunks, [] as [crate::git::DiffHunk; 0]);
    }

    #[test]
    fn parse_diff_flags_binary_files() {
        let raw = "diff --git a/img.png b/img.png\nnew file mode 100644\nindex 0000000..abc1234\nBinary files /dev/null and b/img.png differ\n";
        let files = parse_diff(raw);
        assert_eq!(files.len(), 1);
        assert!(files[0].binary);
        assert_eq!(files[0].hunks, [] as [crate::git::DiffHunk; 0]);
    }

    #[test]
    fn parse_diff_text_file_is_not_binary() {
        let raw = "diff --git a/a.rs b/a.rs\nindex 111..222 100644\n--- a/a.rs\n+++ b/a.rs\n@@ -1 +1,2 @@\n x\n+y\n";
        let files = parse_diff(raw);
        assert!(!files[0].binary);
    }

    #[test]
    fn parse_diff_empty_is_empty() {
        assert_eq!(parse_diff(""), [] as [crate::git::FileDiff; 0]);
    }

    #[test]
    fn merge_outcome_serializes_tagged() {
        let clean = serde_json::to_string(&MergeOutcome::Clean).unwrap();
        assert_eq!(clean, "{\"kind\":\"clean\"}");
        let conflicted = serde_json::to_string(&MergeOutcome::Conflicted {
            files: vec!["f.txt".to_string()],
        })
        .unwrap();
        assert_eq!(
            conflicted,
            "{\"kind\":\"conflicted\",\"files\":[\"f.txt\"]}"
        );
    }

    #[test]
    fn parse_status_example() {
        let input = "\
# branch.oid 279ab2c0000000000000000000000000000000aa
# branch.head main
# branch.upstream origin/main
# branch.ab +1 -0
1 AM N... 000000 100644 100644 0000000 587be6b mod2.txt
? untracked.txt
";
        let status = parse_status(input);
        assert_eq!(
            status,
            RepoStatus {
                branch: "main".to_string(),
                ahead: 1,
                behind: 0,
                dirty_count: 2,
            }
        );
    }

    #[test]
    fn parse_status_clean_no_upstream() {
        let input = "\
# branch.oid 279ab2c0000000000000000000000000000000aa
# branch.head dev
";
        let status = parse_status(input);
        assert_eq!(
            status,
            RepoStatus {
                branch: "dev".to_string(),
                ahead: 0,
                behind: 0,
                dirty_count: 0,
            }
        );
    }

    #[test]
    fn parse_status_behind_three() {
        let input = "\
# branch.head dev
# branch.upstream origin/dev
# branch.ab +0 -3
";
        let status = parse_status(input);
        assert_eq!(status.ahead, 0);
        assert_eq!(status.behind, 3);
    }

    #[test]
    fn parse_status_ignored_not_counted() {
        let input = "\
# branch.head main
1 M. N... 000000 100644 100644 0000000 587be6b tracked.txt
! ignored.txt
? untracked.txt
";
        let status = parse_status(input);
        assert_eq!(status.dirty_count, 2);
    }

    #[test]
    fn parse_status_missing_head_defaults_empty() {
        let input = "1 M. N... 000000 100644 100644 0000000 587be6b tracked.txt\n";
        let status = parse_status(input);
        assert_eq!(status.branch, String::new());
        assert_eq!(status.dirty_count, 1);
    }

    #[test]
    fn session_diff_serializes_base_sha_as_camel_case() {
        let diff = SessionDiff {
            base: "main".to_string(),
            base_sha: Some("abc1234".to_string()),
            files: vec![],
            budget_exceeded: None,
            omitted_untracked: 0,
        };
        let json = serde_json::to_value(&diff).expect("serialize");
        assert_eq!(json["baseSha"], "abc1234");
    }

    #[test]
    fn session_diff_deserializes_missing_base_sha_as_none() {
        // JSON as it would have been stored before `baseSha` existed.
        let json = r#"{"base":"main","files":[]}"#;
        let diff: SessionDiff = serde_json::from_str(json).expect("deserialize");
        assert_eq!(diff.base_sha, None);
    }

    #[test]
    fn untracked_becomes_all_added_hunk() {
        let file = untracked_as_diff("new.txt", "line1\nline2\nline3");
        assert_eq!(file.path, "new.txt");
        assert_eq!(file.old_path, None);
        assert_eq!(file.status, FileChange::Added);
        assert_eq!(file.hunks.len(), 1);
        assert_eq!(file.hunks[0].lines.len(), 3);
        for line in &file.hunks[0].lines {
            assert_eq!(line.kind, DiffKind::Added);
        }
        let texts: Vec<&str> = file.hunks[0]
            .lines
            .iter()
            .map(|l| l.text.as_str())
            .collect();
        assert_eq!(texts, vec!["line1", "line2", "line3"]);
    }

    #[test]
    fn untracked_empty_file_has_no_hunks() {
        let file = untracked_as_diff("empty.txt", "");
        assert_eq!(file.path, "empty.txt");
        assert_eq!(file.status, FileChange::Added);
        assert_eq!(file.hunks, [] as [crate::git::DiffHunk; 0]);
    }

    #[test]
    fn a_file_sized_exactly_to_the_remaining_budget_fits() {
        // The boundary `>` vs `>=` turns on, and the one a real-repo test can
        // only reach by writing a file of an exact size.
        let sized = vec![("exact.txt".to_string(), 64u64)];
        let plan = plan_untracked_reads(&sized, 1000, 64);
        assert_eq!(plan.read, vec!["exact.txt".to_string()]);
        assert_eq!(plan.omitted, 0);
    }

    #[test]
    fn one_byte_past_the_budget_is_omitted_not_truncated() {
        let sized = vec![("over.txt".to_string(), 65u64)];
        let plan = plan_untracked_reads(&sized, 1000, 64);
        assert_eq!(plan.read, [] as [String; 0]);
        assert_eq!(plan.omitted, 1);
    }

    #[test]
    fn the_per_file_cap_bites_before_the_total_does() {
        // A single huge file must not consume the whole budget, even when the
        // budget could afford it.
        let sized = vec![("huge.log".to_string(), 900u64)];
        let plan = plan_untracked_reads(&sized, 100, 10_000);
        assert_eq!(plan.read, [] as [String; 0]);
        assert_eq!(plan.omitted, 1);
    }

    /// The documented-but-arbitrary behaviour: the budget is spent in the order
    /// given (git's sorted order), so a later file loses to earlier ones rather
    /// than by any measure of usefulness. Pinned so a change to it is deliberate.
    #[test]
    fn the_budget_is_spent_in_order_and_later_files_are_counted_not_dropped() {
        let sized = vec![
            ("a.txt".to_string(), 40),
            ("b.txt".to_string(), 40),
            ("c.txt".to_string(), 40),
        ];
        let plan = plan_untracked_reads(&sized, 1000, 100);
        assert_eq!(plan.read, vec!["a.txt".to_string(), "b.txt".to_string()]);
        assert_eq!(plan.omitted, 1);
    }

    #[test]
    fn an_empty_tree_plans_nothing() {
        let plan = plan_untracked_reads(&[], 1000, 1000);
        assert_eq!(plan.read, [] as [String; 0]);
        assert_eq!(plan.omitted, 0);
    }

    #[test]
    fn nul_paths_split_on_the_separator_and_drop_the_trailing_empty() {
        // `git ls-files -z` terminates (not separates) every entry, so the
        // final NUL leaves an empty tail that is not a path.
        let raw = b"a.txt\0dir/b.txt\0";
        assert_eq!(
            parse_nul_paths(raw),
            vec!["a.txt".to_string(), "dir/b.txt".to_string()]
        );
    }

    /// The whole reason this replaced the `--porcelain=v1` parser: `-z` emits
    /// the path's real bytes, so a space or a non-ASCII character needs no
    /// quoting and no octal decoding — the two things the old parser could get
    /// wrong.
    #[test]
    fn nul_paths_keep_spaces_and_non_ascii_verbatim() {
        let raw = "my file.txt\0café.txt\0TestFlight – AcmeLens.crash\0".as_bytes();
        assert_eq!(
            parse_nul_paths(raw),
            vec![
                "my file.txt".to_string(),
                "café.txt".to_string(),
                "TestFlight – AcmeLens.crash".to_string(),
            ]
        );
    }

    #[test]
    fn nul_paths_tolerate_empty_input_and_a_missing_final_separator() {
        assert_eq!(parse_nul_paths(b""), [] as [String; 0]);
        assert_eq!(parse_nul_paths(b"only.txt"), vec!["only.txt".to_string()]);
    }

    /// Tolerant by design, like every other parser here: a non-UTF-8 path (git
    /// permits arbitrary bytes) is skipped, never an error, and never poisons
    /// the entries around it.
    #[test]
    fn nul_paths_skip_a_non_utf8_entry_without_dropping_its_neighbours() {
        let raw = b"good.txt\0bad\xff.txt\0after.txt\0";
        assert_eq!(
            parse_nul_paths(raw),
            vec!["good.txt".to_string(), "after.txt".to_string()]
        );
    }

    /// The [Working-tree budget] fields are additive: a `SessionDiff` persisted
    /// before they existed must still deserialize, defaulting to "no refusal,
    /// nothing omitted" rather than failing the whole load.
    #[test]
    fn session_diff_without_budget_fields_deserializes_to_no_refusal() {
        let json = r#"{"base":"HEAD","baseSha":null,"files":[]}"#;
        let diff: SessionDiff = serde_json::from_str(json).expect("legacy shape still loads");
        assert!(diff.budget_exceeded.is_none());
        assert_eq!(diff.omitted_untracked, 0);
    }

    #[test]
    fn budget_exceeded_serializes_with_camel_case_keys_for_the_frontend() {
        let json = serde_json::to_string(&BudgetExceeded {
            untracked_files: 10_001,
            file_limit: 10_000,
            untracked_dirs: vec!["opt/".to_string()],
        })
        .expect("serializes");
        assert!(json.contains("\"untrackedFiles\":10001"), "got {json}");
        assert!(json.contains("\"fileLimit\":10000"), "got {json}");
        assert!(json.contains("\"untrackedDirs\":[\"opt/\"]"), "got {json}");
    }
}
