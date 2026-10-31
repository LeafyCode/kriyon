//! The Files view's search: how project-wide path matches are ordered for a
//! person looking for one file. Pure — the walk lives in the Tauri shell.
//!
//! A match in the file's own name beats a match in a folder above it, the
//! closer the name is to the query the higher it sits, and among equals the
//! shallower path wins — the order an editor's quick-open gives. Ranked over
//! *every* match, before any cut: ranking a truncated list loses the file
//! whose name is the query whenever earlier paths filled the cut.

use std::cmp::Ordering;

/// Lower is better: 0 the name is the query, 1 the name starts with it, 2 the
/// name contains it, 3 only a folder above it matched. `needle` is lowercase.
fn name_score(path: &str, needle: &str) -> u8 {
    let name = path.rsplit('/').next().unwrap_or(path).to_lowercase();
    if name == needle {
        0
    } else if name.starts_with(needle) {
        1
    } else if name.contains(needle) {
        2
    } else {
        3
    }
}

/// Compare two matching paths for `query` (any case, surrounding spaces
/// ignored): name score, then path length, then the path itself.
#[must_use]
pub fn compare_matches(a: &str, b: &str, query: &str) -> Ordering {
    let needle = query.trim().to_lowercase();
    name_score(a, &needle)
        .cmp(&name_score(b, &needle))
        .then(a.len().cmp(&b.len()))
        .then_with(|| a.cmp(b))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rank<'a>(mut paths: Vec<&'a str>, query: &str) -> Vec<&'a str> {
        paths.sort_by(|a, b| compare_matches(a, b, query));
        paths
    }

    #[test]
    fn exact_name_then_prefix_then_contains_then_folder_only() {
        assert_eq!(
            rank(
                vec![
                    "docs/button/readme.md",
                    "src/ui/IconButton.tsx",
                    "src/ui/Button.tsx",
                    "src/ui/button",
                    "src/ui/ButtonGroup.tsx",
                ],
                "button"
            ),
            vec![
                "src/ui/button",
                "src/ui/Button.tsx",
                "src/ui/ButtonGroup.tsx",
                "src/ui/IconButton.tsx",
                "docs/button/readme.md",
            ]
        );
    }

    #[test]
    fn the_shallower_path_wins_a_tie() {
        assert_eq!(
            rank(vec!["a/b/c/index.ts", "index.ts", "a/index.ts"], "index"),
            vec!["index.ts", "a/index.ts", "a/b/c/index.ts"]
        );
    }

    #[test]
    fn case_and_surrounding_spaces_are_ignored() {
        assert_eq!(
            compare_matches("App.tsx", "app.tsx", "  APP "),
            Ordering::Less
        );
        assert_eq!(name_score("src/App.tsx", "app"), 1);
    }
}
