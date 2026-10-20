use std::path::{Path, PathBuf};

/// Extensions safe to open in the default app — viewable/document/code types,
/// never executables. Lowercase, no leading dot. Enforced only for *open*;
/// reveal-in-Finder bypasses this (selecting a file is inherently safe).
const OPENABLE_EXTENSIONS: &[&str] = &[
    "pdf", "png", "jpg", "jpeg", "gif", "svg", "webp", "bmp", "ico", "avif", "html", "htm", "md",
    "markdown", "txt", "json", "yaml", "yml", "toml", "csv", "log", "xml", "ts", "tsx", "js",
    "jsx", "mjs", "cjs", "rs", "py", "go", "sh", "css", "scss", "rb", "java", "kt", "swift", "c",
    "h", "cpp", "hpp", "sql",
];

/// Strip a trailing `:line` or `:line:col` suffix (each segment all ASCII
/// digits) from a path token. Claude prints references like `src/foo.rs:42`.
#[must_use]
pub fn strip_line_suffix(raw: &str) -> &str {
    let mut s = raw;
    for _ in 0..2 {
        match s.rsplit_once(':') {
            Some((head, tail)) if !tail.is_empty() && tail.bytes().all(|b| b.is_ascii_digit()) => {
                s = head;
            }
            _ => break,
        }
    }
    s
}

/// Resolve a raw path token against a base dir: strip the line suffix, expand a
/// leading `~`, and join relative paths onto `cwd`. Absolute paths pass through.
/// Pure lexical resolution — the caller canonicalizes and checks existence.
#[must_use]
pub fn resolve_lexical(cwd: &Path, home: &Path, raw: &str) -> PathBuf {
    let bare = strip_line_suffix(raw);
    if let Some(rest) = bare.strip_prefix("~/") {
        return home.join(rest);
    }
    if bare == "~" {
        return home.to_path_buf();
    }
    let p = Path::new(bare);
    if p.is_absolute() {
        p.to_path_buf()
    } else {
        cwd.join(p)
    }
}

/// Whether a path's extension is on the open allowlist (case-insensitive).
#[must_use]
pub fn is_openable_extension(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(str::to_ascii_lowercase)
        .is_some_and(|e| OPENABLE_EXTENSIONS.contains(&e.as_str()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_line_and_col_suffix() {
        assert_eq!(strip_line_suffix("src/foo.rs:42"), "src/foo.rs");
        assert_eq!(strip_line_suffix("src/foo.rs:42:7"), "src/foo.rs");
        assert_eq!(strip_line_suffix("src/foo.rs"), "src/foo.rs");
        // A non-numeric trailing segment is not a suffix (e.g. Windows-ish or ports).
        assert_eq!(strip_line_suffix("a:b"), "a:b");
    }

    #[test]
    fn resolve_expands_home_and_joins_relative() {
        let cwd = Path::new("/proj");
        let home = Path::new("/Users/me");
        assert_eq!(
            resolve_lexical(cwd, home, "docs/x.pdf"),
            PathBuf::from("/proj/docs/x.pdf")
        );
        assert_eq!(
            resolve_lexical(cwd, home, "/abs/y.png"),
            PathBuf::from("/abs/y.png")
        );
        assert_eq!(
            resolve_lexical(cwd, home, "~/z.txt"),
            PathBuf::from("/Users/me/z.txt")
        );
        // Line suffix is stripped before joining.
        assert_eq!(
            resolve_lexical(cwd, home, "a/b.rs:10"),
            PathBuf::from("/proj/a/b.rs")
        );
    }

    #[test]
    fn allowlist_accepts_viewable_rejects_executable() {
        assert!(is_openable_extension(Path::new("/x/a.pdf")));
        assert!(is_openable_extension(Path::new("/x/a.PNG")));
        assert!(is_openable_extension(Path::new("/x/a.ts")));
        assert!(!is_openable_extension(Path::new("/x/a.app")));
        assert!(!is_openable_extension(Path::new("/x/a.command")));
        assert!(!is_openable_extension(Path::new("/x/noext")));
    }
}
