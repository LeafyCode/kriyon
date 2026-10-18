//! Pure decisions for a [Worktree bootstrap]: where a worktree lives, how a
//! branch name becomes a directory segment, which install command a lockfile
//! implies, and which `.env*` files to copy. No fs or process work lives here —
//! the shell-out is `src-tauri/src/bootstrap_cmd.rs`. Total: every input yields
//! a value. See CONTEXT.md "Worktree bootstrap" and the 2026-07-02 spec.

/// A branch name as a filesystem-safe directory segment: non-alphanumeric runs
/// collapse to a single `-`, leading/trailing `-` are trimmed, and anything that
/// would reduce to empty or a dot-run falls back to `wt`.
#[must_use]
pub fn sanitize_branch_dir(branch: &str) -> String {
    let mut out = String::with_capacity(branch.len());
    let mut prev_dash = false;
    for ch in branch.chars() {
        if ch.is_ascii_alphanumeric() || ch == '_' || ch == '.' {
            out.push(ch);
            prev_dash = false;
        } else if !prev_dash {
            out.push('-');
            prev_dash = true;
        }
    }
    let trimmed = out.trim_matches(['-', '.'].as_ref());
    if trimmed.is_empty() {
        "wt".to_string()
    } else {
        trimmed.to_string()
    }
}

/// The sibling worktree path for `branch`: `<repo_root>-worktrees/<sanitized>`.
/// Keeping worktrees outside the repo keeps them out of its `git status`.
#[must_use]
pub fn worktree_path_for(repo_root: &str, branch: &str) -> String {
    let root = repo_root.trim_end_matches('/');
    format!("{root}-worktrees/{}", sanitize_branch_dir(branch))
}

/// The dependency-install argv implied by the lockfiles present at the repo
/// root, or `None` when there is nothing to install. Priority is deterministic:
/// pnpm, npm, yarn, bun.
#[must_use]
pub fn detect_install(present_files: &[&str]) -> Option<&'static [&'static str]> {
    const PNPM: &[&str] = &["pnpm", "install"];
    const NPM: &[&str] = &["npm", "install"];
    const YARN: &[&str] = &["yarn"];
    const BUN: &[&str] = &["bun", "install"];
    if present_files.contains(&"pnpm-lock.yaml") {
        Some(PNPM)
    } else if present_files.contains(&"package-lock.json") {
        Some(NPM)
    } else if present_files.contains(&"yarn.lock") {
        Some(YARN)
    } else if present_files.contains(&"bun.lockb") {
        Some(BUN)
    } else {
        None
    }
}

/// From a directory listing, the top-level dotenv files to copy into a fresh
/// worktree: exactly `.env` and `.env.*` (so `.env.local`, `.env.production`),
/// never `.envrc` (direnv) or unrelated files. Order is preserved.
#[must_use]
pub fn env_files_to_copy(entries: &[String]) -> Vec<String> {
    entries
        .iter()
        .filter(|name| *name == ".env" || name.starts_with(".env."))
        .cloned()
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitizes_branch_into_a_dir_segment() {
        assert_eq!(sanitize_branch_dir("feat/foo"), "feat-foo");
        assert_eq!(sanitize_branch_dir("fix/a b"), "fix-a-b");
        assert_eq!(sanitize_branch_dir("plain"), "plain");
        // Collapses runs and trims separators so no empty or ".."-ish segment.
        assert_eq!(sanitize_branch_dir("a//b"), "a-b");
        assert_eq!(sanitize_branch_dir("/lead/"), "lead");
        assert_eq!(sanitize_branch_dir(".."), "wt");
        assert_eq!(sanitize_branch_dir(""), "wt");
    }

    #[test]
    fn worktree_path_is_a_sibling_of_the_repo() {
        assert_eq!(
            worktree_path_for("/Users/x/Projects/kriyon", "feat/foo"),
            "/Users/x/Projects/kriyon-worktrees/feat-foo"
        );
        // A trailing slash on the repo root is tolerated.
        assert_eq!(
            worktree_path_for("/Users/x/Projects/kriyon/", "wt"),
            "/Users/x/Projects/kriyon-worktrees/wt"
        );
    }

    #[test]
    fn detects_install_from_lockfile_priority() {
        assert_eq!(
            detect_install(&["pnpm-lock.yaml"]),
            Some(&["pnpm", "install"][..])
        );
        assert_eq!(
            detect_install(&["package-lock.json"]),
            Some(&["npm", "install"][..])
        );
        assert_eq!(detect_install(&["yarn.lock"]), Some(&["yarn"][..]));
        assert_eq!(
            detect_install(&["bun.lockb"]),
            Some(&["bun", "install"][..])
        );
        // pnpm wins when several are present (deterministic priority).
        assert_eq!(
            detect_install(&["package-lock.json", "pnpm-lock.yaml"]),
            Some(&["pnpm", "install"][..])
        );
        // No JS lockfile → nothing to run (Cargo builds lazily).
        assert_eq!(detect_install(&["Cargo.toml"]), None);
        assert_eq!(detect_install(&[]), None);
    }

    #[test]
    fn env_files_are_dotenv_only() {
        let entries = vec![
            ".env".to_string(),
            ".env.local".to_string(),
            ".env.production".to_string(),
            ".envrc".to_string(), // direnv, not a dotenv file
            "env".to_string(),
            "README.md".to_string(),
        ];
        assert_eq!(
            env_files_to_copy(&entries),
            vec![
                ".env".to_string(),
                ".env.local".to_string(),
                ".env.production".to_string()
            ]
        );
    }
}
