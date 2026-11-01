//! Parser for `git blame --porcelain`: which commit last touched each line
//! of a file. Pure — no process spawning or IO lives here.

use serde::{Deserialize, Serialize};

/// One commit that last touched at least one line.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BlameCommit {
    /// Full object id.
    pub sha: String,
    pub author: String,
    /// Author time, in seconds since the epoch.
    pub author_time: i64,
    /// The commit message's first line.
    pub summary: String,
    /// git's all-zero id: the line differs from what is committed.
    pub uncommitted: bool,
}

/// Who last touched each line of one file.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileBlame {
    /// Every commit named below, each once.
    pub commits: Vec<BlameCommit>,
    /// Per line, in order (index 0 is line 1): an index into `commits`.
    pub lines: Vec<u32>,
}

/// Is `word` a git object id (40 hex for SHA-1, 64 for SHA-256)?
fn is_oid(word: &str) -> bool {
    matches!(word.len(), 40 | 64) && word.bytes().all(|b| b.is_ascii_hexdigit())
}

/// Parse `git blame --porcelain` output.
///
/// The format names a commit on a header line (`<sha> <orig> <final>
/// [<count>]`) before each line of content, and spells out the commit's
/// details only the first time it appears. Content lines are the only ones
/// that start with a tab, so a tab is what tells content from metadata — a
/// line of code that happens to look like a header is still code. Unknown
/// keys are skipped, so a newer git adding one breaks nothing.
#[must_use]
pub fn parse_blame_porcelain(raw: &str) -> FileBlame {
    let mut blame = FileBlame::default();
    let mut index_of: std::collections::HashMap<String, u32> = std::collections::HashMap::new();
    let mut current: Option<u32> = None;
    for line in raw.lines() {
        if line.starts_with('\t') {
            if let Some(index) = current {
                blame.lines.push(index);
            }
            continue;
        }
        let (key, value) = line.split_once(' ').unwrap_or((line, ""));
        if is_oid(key) {
            let next = u32::try_from(blame.commits.len()).unwrap_or(u32::MAX);
            let index = *index_of.entry(key.to_string()).or_insert_with(|| {
                blame.commits.push(BlameCommit {
                    sha: key.to_string(),
                    author: String::new(),
                    author_time: 0,
                    summary: String::new(),
                    uncommitted: key.bytes().all(|b| b == b'0'),
                });
                next
            });
            current = Some(index);
            continue;
        }
        let Some(commit) = current.and_then(|i| blame.commits.get_mut(i as usize)) else {
            continue;
        };
        match key {
            "author" => commit.author = value.to_string(),
            "author-time" => commit.author_time = value.trim().parse().unwrap_or(0),
            "summary" => commit.summary = value.to_string(),
            _ => {}
        }
    }
    blame
}

#[cfg(test)]
mod tests {
    use super::*;

    const A: &str = "1111111111111111111111111111111111111111";
    const B: &str = "2222222222222222222222222222222222222222";
    const ZERO: &str = "0000000000000000000000000000000000000000";

    fn porcelain() -> String {
        format!(
            "{A} 1 1 2\n\
             author Ada\n\
             author-mail <ada@example.com>\n\
             author-time 1700000000\n\
             author-tz +0000\n\
             committer Ada\n\
             committer-mail <ada@example.com>\n\
             committer-time 1700000000\n\
             committer-tz +0000\n\
             summary First commit\n\
             filename a.ts\n\
             \tline one\n\
             {A} 2 2\n\
             \tline two\n\
             {ZERO} 3 3 1\n\
             author Not Committed Yet\n\
             author-mail <not.committed.yet>\n\
             author-time 1800000000\n\
             author-tz +0000\n\
             summary Version of a.ts from a.ts\n\
             filename a.ts\n\
             \tline three\n\
             {B} 3 4 1\n\
             author Bo\n\
             author-time 1750000000\n\
             summary Second: with a \\ttab-looking summary\n\
             previous {A} a.ts\n\
             boundary\n\
             filename a.ts\n\
             \tline four\n\
             {A} 4 5 1\n\
             filename a.ts\n\
             \t\tindented line five\n"
        )
    }

    #[test]
    fn maps_each_line_to_its_commit_in_order() {
        let blame = parse_blame_porcelain(&porcelain());
        let shas: Vec<&str> = blame
            .lines
            .iter()
            .map(|i| blame.commits[*i as usize].sha.as_str())
            .collect();
        assert_eq!(shas, vec![A, A, ZERO, B, A]);
    }

    #[test]
    fn records_each_commit_once_with_its_details() {
        let blame = parse_blame_porcelain(&porcelain());
        assert_eq!(blame.commits.len(), 3);
        let a = &blame.commits[0];
        assert_eq!(a.author, "Ada");
        assert_eq!(a.author_time, 1_700_000_000);
        assert_eq!(a.summary, "First commit");
        assert!(!a.uncommitted);
        assert!(blame.commits[1].uncommitted);
        assert_eq!(
            blame.commits[2].summary,
            "Second: with a \\ttab-looking summary"
        );
    }

    #[test]
    fn a_content_line_that_looks_like_a_header_is_still_content() {
        // A tab-led line is always content, whatever follows the tab.
        let raw =
            format!("{A} 1 1 1\nauthor Ada\nauthor-time 1\nsummary s\nfilename x\n\t{B} 9 9 9\n");
        let blame = parse_blame_porcelain(&raw);
        assert_eq!(blame.lines, vec![0]);
        assert_eq!(blame.commits.len(), 1);
    }

    #[test]
    fn empty_output_is_an_empty_blame() {
        assert_eq!(parse_blame_porcelain(""), FileBlame::default());
    }
}
