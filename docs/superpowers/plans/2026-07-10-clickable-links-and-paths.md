# Clickable Links & File Paths Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make file paths and web URLs that Claude prints clickable in both the xterm terminal and the structured view — click opens in the default app, Cmd-click reveals in Finder.

**Architecture:** A pure resolver in `kriyon-core` strips line suffixes / expands `~` / joins relative paths; a thin `open_path` Tauri command validates the session cwd (reusing the existing `validate_cwd` trust-boundary helper), canonicalizes, checks existence + an open-extension allowlist, then calls the opener plugin. The frontend gets two bridge helpers plus a shared `<FileLink>` component and link matchers; the terminal loads the already-installed `WebLinksAddon` and a custom `registerLinkProvider`.

**Tech Stack:** Rust (Tauri v2, `tauri-plugin-opener` 2.5), TypeScript/React, `@xterm/xterm` + `@xterm/addon-web-links` (already a dependency), Vitest, `cargo test`.

## Global Constraints

- Never hand-format. Run `pnpm fix` (Biome + Ultracite own JS/TS formatting & lint).
- `pnpm check` must pass before every commit (typecheck + lint + tests, Rust fmt/clippy).
- TDD: write the failing test first, watch it fail, then implement.
- Conventional commits, small and frequent. Current branch `feat/bug-fixes-3` (never commit to `main`/`master`).
- IPC is a trust boundary: every path crossing JS→Rust is re-validated in Rust; never pass a raw frontend string to the OS.
- Pure logic lives in `crates/kriyon-core` (unit-testable without Tauri); `src-tauri` is the thin shell.
- Design values (colors/spacing) come from `src/theme/tokens.ts` — never hardcode.
- Web links restricted to http/https only.

---

### Task 1: Pure link resolver in `kriyon-core`

**Files:**
- Create: `crates/kriyon-core/src/links.rs`
- Modify: `crates/kriyon-core/src/lib.rs` (add `pub mod links;` — keep the list alphabetical; it sits between `history` and `main_session`... actually between `hooks` and `main_session`: insert `pub mod links;` after `pub mod hooks;` on line 9)
- Test: inline `#[cfg(test)]` module in `crates/kriyon-core/src/links.rs`

**Interfaces:**
- Produces:
  - `kriyon_core::links::strip_line_suffix(raw: &str) -> &str`
  - `kriyon_core::links::resolve_lexical(cwd: &Path, home: &Path, raw: &str) -> PathBuf`
  - `kriyon_core::links::is_openable_extension(path: &Path) -> bool`

- [ ] **Step 1: Register the module**

In `crates/kriyon-core/src/lib.rs`, after the line `pub mod hooks;`, add:

```rust
pub mod links;
```

- [ ] **Step 2: Write the failing tests**

Create `crates/kriyon-core/src/links.rs` with only the test module first:

```rust
use std::path::{Path, PathBuf};

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
        assert_eq!(resolve_lexical(cwd, home, "docs/x.pdf"), PathBuf::from("/proj/docs/x.pdf"));
        assert_eq!(resolve_lexical(cwd, home, "/abs/y.png"), PathBuf::from("/abs/y.png"));
        assert_eq!(resolve_lexical(cwd, home, "~/z.txt"), PathBuf::from("/Users/me/z.txt"));
        // Line suffix is stripped before joining.
        assert_eq!(resolve_lexical(cwd, home, "a/b.rs:10"), PathBuf::from("/proj/a/b.rs"));
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
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cargo test -p kriyon-core links`
Expected: FAIL — `cannot find function strip_line_suffix` (etc.).

- [ ] **Step 4: Implement the resolver**

Prepend the implementation above the test module in `crates/kriyon-core/src/links.rs`:

```rust
/// Extensions safe to open in the default app — viewable/document/code types,
/// never executables. Lowercase, no leading dot. Enforced only for *open*;
/// reveal-in-Finder bypasses this (selecting a file is inherently safe).
const OPENABLE_EXTENSIONS: &[&str] = &[
    "pdf", "png", "jpg", "jpeg", "gif", "svg", "webp", "bmp", "ico", "avif",
    "html", "htm", "md", "markdown", "txt", "json", "yaml", "yml", "toml",
    "csv", "log", "xml", "ts", "tsx", "js", "jsx", "mjs", "cjs", "rs", "py",
    "go", "sh", "css", "scss", "rb", "java", "kt", "swift", "c", "h", "cpp",
    "hpp", "sql",
];

/// Strip a trailing `:line` or `:line:col` suffix (each segment all ASCII
/// digits) from a path token. Claude prints references like `src/foo.rs:42`.
#[must_use]
pub fn strip_line_suffix(raw: &str) -> &str {
    let mut s = raw;
    for _ in 0..2 {
        match s.rsplit_once(':') {
            Some((head, tail))
                if !tail.is_empty() && tail.bytes().all(|b| b.is_ascii_digit()) =>
            {
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
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cargo test -p kriyon-core links`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add crates/kriyon-core/src/links.rs crates/kriyon-core/src/lib.rs
git commit -m "feat(core): pure link/path resolver with open-extension allowlist"
```

---

### Task 2: `open_path` Tauri command + capabilities

**Files:**
- Create: `src-tauri/src/links_cmd.rs`
- Modify: `src-tauri/src/lib.rs` (add `mod links_cmd;` near the other `mod` declarations, and `links_cmd::open_path` to the `invoke_handler!` list at line 273 — add after `commands::session_snapshots`)
- Modify: `src-tauri/src/completion_cmd.rs:229` (change `fn validate_cwd` to `pub(crate) fn validate_cwd`)
- Modify: `src-tauri/capabilities/default.json` (grant two opener permissions)

**Interfaces:**
- Consumes: `kriyon_core::links::{resolve_lexical, is_openable_extension}` (Task 1); `crate::completion_cmd::validate_cwd`; `crate::commands::resolve_home`.
- Produces: Tauri command `open_path(cwd: String, path: String, reveal: bool) -> Result<(), String>`.

- [ ] **Step 1: Make `validate_cwd` reusable**

In `src-tauri/src/completion_cmd.rs` line 229, change:

```rust
fn validate_cwd(store: &StoreState, cwd: &Path) -> Result<PathBuf, String> {
```

to:

```rust
pub(crate) fn validate_cwd(store: &StoreState, cwd: &Path) -> Result<PathBuf, String> {
```

- [ ] **Step 2: Write the command**

Create `src-tauri/src/links_cmd.rs`. (Mirror the store/state imports used at the top of `completion_cmd.rs`; `StoreState` is the same type used by `list_files`.)

```rust
//! Opening and revealing files that Claude references in its output. The single
//! `open_path` command is the trust boundary: the frontend sends the session
//! `cwd` and a raw path token, and this module re-validates both before any OS
//! call — the raw string never reaches the opener unchecked.

use std::path::Path;

use tauri_plugin_opener::OpenerExt as _;

use crate::commands::resolve_home;
use crate::completion_cmd::validate_cwd;
use crate::StoreState;

/// Open (or reveal) a file referenced in Claude's output. `cwd` is the session's
/// working directory — validated against the known session/project roots — and
/// `path` is resolved against it. `reveal` selects the file in Finder instead of
/// opening it in the default app.
///
/// # Errors
/// Returns an error string when `cwd` is not a known root, when `path` does not
/// resolve to an existing file, or (for open, not reveal) when the file's
/// extension is not on the viewable allowlist. The frontend treats any error as
/// a silent no-op.
#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
pub fn open_path(
    app: tauri::AppHandle,
    store: tauri::State<'_, StoreState>,
    cwd: String,
    path: String,
    reveal: bool,
) -> Result<(), String> {
    let base = validate_cwd(&store, Path::new(&cwd))?;
    let home = resolve_home(&app)?;
    let lexical = kriyon_core::links::resolve_lexical(&base, &home, &path);
    let target = lexical
        .canonicalize()
        .map_err(|_| "path does not exist".to_string())?;
    if !target.is_file() {
        return Err("not a file".to_string());
    }
    if reveal {
        return app
            .opener()
            .reveal_item_in_dir(&target)
            .map_err(|e| e.to_string());
    }
    if !kriyon_core::links::is_openable_extension(&target) {
        return Err("file type not openable".to_string());
    }
    app.opener()
        .open_path(target.to_string_lossy().into_owned(), None::<&str>)
        .map_err(|e| e.to_string())
}
```

- [ ] **Step 3: Register the module and command**

In `src-tauri/src/lib.rs`, add near the other module declarations (e.g. beside `mod completion_cmd;`):

```rust
mod links_cmd;
```

Then in the `tauri::generate_handler![ ... ]` list, change the last entry `commands::session_snapshots` to add the new command:

```rust
            commands::session_snapshots,
            links_cmd::open_path
```

- [ ] **Step 4: Grant opener capabilities**

In `src-tauri/capabilities/default.json`, add two entries to the `"permissions"` array (next to the existing `"opener:default"`):

```json
    "opener:allow-open-path",
    "opener:allow-reveal-item-in-dir",
```

- [ ] **Step 5: Verify it compiles and clippy is clean**

Run: `cargo clippy -p kriyon --all-targets -- -D warnings` (from `src-tauri`, or `cargo clippy` at repo root per project scripts)
Expected: builds with no warnings. (No unit test here — the command is thin glue over the Task 1 resolver, which is already tested; behavior is verified end-to-end in Task 7 QA.)

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/links_cmd.rs src-tauri/src/lib.rs src-tauri/src/completion_cmd.rs src-tauri/capabilities/default.json
git commit -m "feat(tauri): open_path command to open/reveal referenced files"
```

---

### Task 3: Bridge helpers

**Files:**
- Modify: `src/ipc/bridge.ts` (add two helpers next to `openExternalUrl` at line 321)
- Test: `src/ipc/bridge.test.ts` (create if absent; otherwise append)

**Interfaces:**
- Consumes: the `open_path` command (Task 2).
- Produces: `openPath(cwd: string, path: string): Promise<void>`, `revealPath(cwd: string, path: string): Promise<void>` in `src/ipc/bridge.ts`. (`openExternalUrl` already exists for web URLs.)

- [ ] **Step 1: Write the failing test**

Create `src/ipc/bridge.test.ts` (outside Tauri, `hasTauri()` is false, so the helpers must resolve without invoking):

```ts
import { describe, expect, it } from "vitest";
import { openPath, revealPath } from "./bridge.ts";

describe("file-open bridge helpers", () => {
  it("openPath no-ops (resolves) outside Tauri", async () => {
    await expect(openPath("/proj", "docs/x.pdf")).resolves.toBeUndefined();
  });
  it("revealPath no-ops (resolves) outside Tauri", async () => {
    await expect(revealPath("/proj", "docs/x.pdf")).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/ipc/bridge.test.ts`
Expected: FAIL — `openPath is not a function` / import error.

- [ ] **Step 3: Implement the helpers**

In `src/ipc/bridge.ts`, after `openExternalUrl` (ends line 321), add:

```ts
/**
 * Open a file referenced by Claude in the OS default app. `cwd` is the session's
 * working dir (used to resolve a relative `path`); the Rust `open_path` command
 * re-validates both and no-ops on a missing or non-openable file. No-ops outside
 * the Tauri webview (browser QA).
 */
export function openPath(cwd: string, path: string): Promise<void> {
  if (!hasTauri()) {
    return Promise.resolve();
  }
  return invoke("open_path", { cwd, path, reveal: false });
}

/** Reveal a referenced file in Finder (selects, does not open). See {@link openPath}. */
export function revealPath(cwd: string, path: string): Promise<void> {
  if (!hasTauri()) {
    return Promise.resolve();
  }
  return invoke("open_path", { cwd, path, reveal: true });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/ipc/bridge.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/ipc/bridge.ts src/ipc/bridge.test.ts
git commit -m "feat(ipc): openPath/revealPath bridge helpers"
```

---

### Task 4: Link matchers util

**Files:**
- Create: `src/studio/links.ts`
- Test: `src/studio/links.test.ts`

**Interfaces:**
- Produces:
  - `URL_RE: RegExp` (global, http/https)
  - `looksLikePath(text: string): boolean`

- [ ] **Step 1: Write the failing tests**

Create `src/studio/links.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { looksLikePath, URL_RE } from "./links.ts";

describe("URL_RE", () => {
  it("matches http(s) URLs and stops at trailing punctuation", () => {
    const s = "see https://example.com/a?b=1 and http://x.io.";
    const found = [...s.matchAll(URL_RE)].map((m) => m[0]);
    expect(found).toEqual(["https://example.com/a?b=1", "http://x.io"]);
  });
});

describe("looksLikePath", () => {
  it("accepts pathish backtick contents", () => {
    expect(looksLikePath("src/foo.ts")).toBe(true);
    expect(looksLikePath("report.pdf")).toBe(true);
    expect(looksLikePath("src/foo.ts:42")).toBe(true);
  });
  it("rejects prose and code that is not a path", () => {
    expect(looksLikePath("useEffect")).toBe(false);
    expect(looksLikePath("const x = 1")).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/studio/links.test.ts`
Expected: FAIL — cannot resolve `./links.ts`.

- [ ] **Step 3: Implement the matchers**

Create `src/studio/links.ts`:

```ts
/**
 * Inline link detection for the structured view. `URL_RE` matches http/https
 * URLs; `looksLikePath` decides whether a backtick code-span is a file path
 * worth linking. Both are deliberately loose — the Rust `open_path` command
 * no-ops on anything that does not resolve to a real, openable file.
 */

/** http/https URLs, stopping before common trailing punctuation. Global (used with matchAll). */
export const URL_RE = /https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"]/g;

/** A backtick span reads as a file path if it contains a slash or ends in a
 *  short file extension (optionally followed by a `:line` suffix). */
export function looksLikePath(text: string): boolean {
  const bare = text.split(":")[0];
  if (bare.includes(" ")) {
    return false;
  }
  return bare.includes("/") || /\.[A-Za-z0-9]{1,8}$/.test(bare);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/studio/links.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/studio/links.ts src/studio/links.test.ts
git commit -m "feat(studio): URL and file-path inline matchers"
```

---

### Task 5: Shared `<FileLink>` component

**Files:**
- Create: `src/studio/blocks/FileLink.tsx`
- Test: `src/studio/blocks/FileLink.test.tsx`

**Interfaces:**
- Consumes: `openPath`, `revealPath` (Task 3).
- Produces: `FileLink({ cwd, path, style?, children? })` — click → `openPath(cwd, path)`, Cmd/Ctrl-click → `revealPath(cwd, path)`.

- [ ] **Step 1: Write the failing test**

Create `src/studio/blocks/FileLink.test.tsx`:

```tsx
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const openPath = vi.fn(() => Promise.resolve());
const revealPath = vi.fn(() => Promise.resolve());
vi.mock("../../ipc/bridge.ts", () => ({ openPath, revealPath }));

import { FileLink } from "./FileLink.tsx";

describe("FileLink", () => {
  it("plain click opens, Cmd-click reveals", () => {
    render(<FileLink cwd="/proj" path="docs/x.pdf" />);
    const link = screen.getByTestId("file-link");
    fireEvent.click(link);
    expect(openPath).toHaveBeenCalledWith("/proj", "docs/x.pdf");
    fireEvent.click(link, { metaKey: true });
    expect(revealPath).toHaveBeenCalledWith("/proj", "docs/x.pdf");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/studio/blocks/FileLink.test.tsx`
Expected: FAIL — cannot resolve `./FileLink.tsx`.

- [ ] **Step 3: Implement the component**

Create `src/studio/blocks/FileLink.tsx`:

```tsx
import type { CSSProperties, ReactNode } from "react";
import { openPath, revealPath } from "../../ipc/bridge.ts";
import { tokens } from "../../theme/tokens.ts";

const linkStyle: CSSProperties = {
  color: "inherit",
  cursor: "pointer",
  textDecorationColor: tokens.color.line.strong,
  textDecorationLine: "underline",
  textUnderlineOffset: "2px",
};

function dispatch(cwd: string, path: string, reveal: boolean): void {
  const fn = reveal ? revealPath : openPath;
  fn(cwd, path).catch(() => {
    // Best-effort: a missing or non-openable file no-ops backend-side.
  });
}

/**
 * Renders `path` as a clickable link: click opens it in the default app,
 * Cmd/Ctrl-click reveals it in Finder. `cwd` scopes relative-path resolution.
 * `children` overrides the visible text (defaults to `path`).
 */
export function FileLink({
  cwd,
  path,
  style,
  children,
}: {
  cwd: string;
  path: string;
  style?: CSSProperties;
  children?: ReactNode;
}) {
  return (
    <span
      data-testid="file-link"
      onClick={(e) => {
        e.preventDefault();
        dispatch(cwd, path, e.metaKey || e.ctrlKey);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          dispatch(cwd, path, e.metaKey || e.ctrlKey);
        }
      }}
      role="link"
      style={{ ...linkStyle, ...style }}
      tabIndex={0}
    >
      {children ?? path}
    </span>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/studio/blocks/FileLink.test.tsx`
Expected: PASS. Then run `pnpm fix` to satisfy Ultracite (a11y/formatting).

- [ ] **Step 5: Commit**

```bash
git add src/studio/blocks/FileLink.tsx src/studio/blocks/FileLink.test.tsx
git commit -m "feat(studio): FileLink component (click=open, cmd-click=reveal)"
```

---

### Task 6: Wire the structured view

**Files:**
- Modify: `src/studio/StudioView.tsx` (read `cwd` from the store; thread it into `renderEvent` and the path-bearing blocks)
- Modify: `src/studio/blocks/Tool.tsx` (wrap `target` in `FileLink`)
- Modify: `src/studio/blocks/Diff.tsx:124` (wrap `file` in `FileLink`)
- Modify: `src/studio/blocks/Code.tsx` (wrap `file` in `FileLink`)
- Modify: `src/studio/blocks/Text.tsx` (URLs + backtick paths become links)
- Test: `src/studio/blocks/Tool.test.tsx`, `src/studio/blocks/Text.test.tsx` (create/append)

**Interfaces:**
- Consumes: `FileLink` (Task 5); `URL_RE`, `looksLikePath` (Task 4); `openExternalUrl` (existing bridge); `useSessions` store (`sessions[sessionId]?.cwd`).
- Produces: `Tool`, `Diff`, `Code`, `Text` each now accept a `cwd: string` prop.

- [ ] **Step 1: Thread `cwd` from StudioView**

In `src/studio/StudioView.tsx`, inside `StudioView` add (near the other `useSessions` selectors, ~line 79):

```tsx
  const cwd = useSessions((state) => state.sessions[sessionId]?.cwd ?? "");
```

Change `renderEvent`'s signature to take `cwd` and pass it to the four blocks. Replace the `prompt`/`assistant`/`tool`/`diff`/`code` cases so they pass `cwd`:

```tsx
function renderEvent(event: StudioEvent, key: string, cwd: string) {
  switch (event.kind) {
    case "prompt":
      return <Prompt key={key} text={event.text} />;
    case "assistant":
      return <Text cwd={cwd} key={key} text={event.text} />;
    case "tool":
      return <Tool cwd={cwd} key={key} name={event.name} target={event.target} />;
    case "bash":
      return <Bash cmd={event.cmd} key={key} output={event.output} />;
    case "diff":
      return (
        <Diff
          additions={event.additions}
          cwd={cwd}
          deletions={event.deletions}
          file={event.file}
          key={key}
          lines={event.lines}
        />
      );
    case "code":
      return (
        <Code cwd={cwd} file={event.file} key={key} lang={event.lang} lines={event.lines} />
      );
    case "question":
      return <Question key={key} questions={event.questions} />;
    case "usage":
      return null;
    default:
      return null;
  }
}
```

Find the call site of `renderEvent(event, ...)` in the JSX below and pass `cwd` as the third argument (e.g. `renderEvent(e, e.id, cwd)`).

- [ ] **Step 2: Write the failing block tests**

Create `src/studio/blocks/Tool.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
vi.mock("../../ipc/bridge.ts", () => ({ openPath: vi.fn(), revealPath: vi.fn() }));
import { Tool } from "./Tool.tsx";

describe("Tool", () => {
  it("renders its target as a FileLink", () => {
    render(<Tool cwd="/proj" name="Read" target="src/a.ts" />);
    expect(screen.getByTestId("file-link")).toHaveTextContent("src/a.ts");
  });
  it("renders nothing extra when target is null", () => {
    render(<Tool cwd="/proj" name="Bash" target={null} />);
    expect(screen.queryByTestId("file-link")).toBeNull();
  });
});
```

Create `src/studio/blocks/Text.test.tsx`:

```tsx
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
const openExternalUrl = vi.fn();
vi.mock("../../ipc/bridge.ts", () => ({ openExternalUrl, openPath: vi.fn(), revealPath: vi.fn() }));
import { Text } from "./Text.tsx";

describe("Text", () => {
  it("makes a URL clickable", () => {
    render(<Text cwd="/proj" text="visit https://example.com now" />);
    fireEvent.click(screen.getByText("https://example.com"));
    expect(openExternalUrl).toHaveBeenCalledWith("https://example.com");
  });
  it("makes a backtick path a FileLink", () => {
    render(<Text cwd="/proj" text="see `src/a.ts` here" />);
    expect(screen.getByTestId("file-link")).toHaveTextContent("src/a.ts");
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm vitest run src/studio/blocks/Tool.test.tsx src/studio/blocks/Text.test.tsx`
Expected: FAIL — `Tool`/`Text` don't accept `cwd`; no `file-link` rendered.

- [ ] **Step 4: Update Tool.tsx**

In `src/studio/blocks/Tool.tsx`, import FileLink and change the signature + target render (lines 63-76):

```tsx
import { FileLink } from "./FileLink.tsx";
// ...
export function Tool({
  name,
  target,
  cwd,
}: {
  name: string;
  target: string | null;
  cwd: string;
}) {
  return (
    <span data-testid="block-tool" style={rootStyle}>
      <span style={iconStyle}>{glyphFor(name)}</span>
      <span style={nameStyle}>{name}</span>
      {target ? <FileLink cwd={cwd} path={target} style={targetStyle} /> : null}
    </span>
  );
}
```

- [ ] **Step 5: Update Diff.tsx and Code.tsx**

In `src/studio/blocks/Diff.tsx`: import `FileLink`, add `cwd: string` to its props, and replace the file span (line 124, `<span style={fileStyle}>{file}</span>`) with:

```tsx
          <FileLink cwd={cwd} path={file} style={fileStyle} />
```

In `src/studio/blocks/Code.tsx`: import `FileLink`, add `cwd: string` to its props, and wrap the rendered `file` name the same way — replace the plain `file` span with `<FileLink cwd={cwd} path={file} style={<existing file style>} />`. (Open `Code.tsx`, find where `file` renders, and mirror the Diff change.)

- [ ] **Step 6: Update Text.tsx**

In `src/studio/blocks/Text.tsx`, import the matchers, bridge, and FileLink, extend `INLINE`, add URL/path handling, and pass `cwd`:

```tsx
import { openExternalUrl } from "../../ipc/bridge.ts";
import { URL_RE, looksLikePath } from "../links.ts";
import { FileLink } from "./FileLink.tsx";
```

Change the split regex (line 43) to also capture bare URLs:

```tsx
// Splits on `**bold**`, `` `code` ``, and http(s) URLs, keeping delimiters.
const INLINE = /(\*\*[^*]+\*\*|`[^`]+`|https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])/;
```

Update `renderInline` to take `cwd`, turn URL chunks into links, and turn pathish backtick spans into `FileLink`:

```tsx
function renderInline(text: string, cwd: string): ReactNode[] {
  return text.split(INLINE).map((chunk, index) => {
    const key = `${index}-${chunk}`;
    if (chunk.startsWith("**") && chunk.endsWith("**")) {
      return (
        <strong key={key} style={strongStyle}>
          {chunk.slice(2, -2)}
        </strong>
      );
    }
    if (URL_RE.test(chunk)) {
      return (
        <span
          key={key}
          onClick={() => {
            openExternalUrl(chunk).catch(() => {
              // best-effort
            });
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              openExternalUrl(chunk).catch(() => {
                // best-effort
              });
            }
          }}
          role="link"
          style={{ color: tokens.color.accent, cursor: "pointer", textDecorationLine: "underline" }}
          tabIndex={0}
        >
          {chunk}
        </span>
      );
    }
    if (chunk.startsWith("`") && chunk.endsWith("`")) {
      const inner = chunk.slice(1, -1);
      if (looksLikePath(inner)) {
        return <FileLink cwd={cwd} key={key} path={inner} style={codeStyle} />;
      }
      return (
        <code key={key} style={codeStyle}>
          {inner}
        </code>
      );
    }
    return <span key={key}>{chunk}</span>;
  });
}
```

> Note: `URL_RE` is global (`/g`), which makes `.test()` stateful. Use a fresh non-global check here instead — replace `URL_RE.test(chunk)` with `/^https?:\/\//.test(chunk)` since each URL chunk from the split starts with the scheme. Update the Task 4 import accordingly (only `looksLikePath` is needed in Text.tsx).

Update the `Text` component to accept and pass `cwd`:

```tsx
export function Text({ text, cwd }: { text: string; cwd: string }) {
  return (
    <div data-testid="block-text" style={rootStyle}>
      <span style={dotStyle} />
      <div style={proseStyle}>{renderInline(text, cwd)}</div>
    </div>
  );
}
```

- [ ] **Step 7: Run the block tests and the full suite**

Run: `pnpm vitest run src/studio/`
Expected: PASS (new Tool/Text tests plus existing studio tests still green). Then `pnpm fix` and `pnpm check`.

- [ ] **Step 8: Commit**

```bash
git add src/studio/StudioView.tsx src/studio/blocks/Tool.tsx src/studio/blocks/Diff.tsx src/studio/blocks/Code.tsx src/studio/blocks/Text.tsx src/studio/blocks/Tool.test.tsx src/studio/blocks/Text.test.tsx
git commit -m "feat(studio): clickable file paths and URLs in the structured view"
```

---

### Task 7: Terminal links (WebLinksAddon + path provider)

**Files:**
- Modify: `src/terminal/Terminal.tsx` (import + load `WebLinksAddon`; register a path link provider; both use `cwd` prop and the bridge)

**Interfaces:**
- Consumes: `openExternalUrl`, `openPath`, `revealPath` (bridge); `cwd` prop (already on `Terminal`, line ~166).

- [ ] **Step 1: Add imports**

In `src/terminal/Terminal.tsx`, add:

```tsx
import { WebLinksAddon } from "@xterm/addon-web-links";
```

and extend the bridge import on line 7 to include the new helpers:

```tsx
import { openExternalUrl, openPath, reportDrained, resizePty, revealPath, writeStdin } from "../ipc/bridge.ts";
```

- [ ] **Step 2: Load WebLinksAddon and a path provider**

After the `FitAddon` is loaded (`term.loadAddon(fit); term.open(container);` around lines 218-221), add — inside the mount effect where `cwd` and `term` are in scope:

```tsx
    // Web URLs → default browser (http/https only).
    term.loadAddon(
      new WebLinksAddon((_event, uri) => {
        openExternalUrl(uri).catch(() => {
          // best-effort
        });
      })
    );

    // File paths → open in default app; Cmd/Ctrl-click reveals in Finder. The
    // backend re-validates and no-ops on a non-existent / non-openable path, so
    // this matcher can be loose. Path token: optional `~`/`./`/`../` prefix, at
    // least one `/segment`... `.ext`, optional `:line[:col]`.
    const PATH_RE =
      /(?:~|\.{0,2})(?:\/[\w.@+-]+)+\.[A-Za-z0-9]{1,8}(?::\d+(?::\d+)?)?/g;
    term.registerLinkProvider({
      provideLinks(lineNumber, callback) {
        const line = term.buffer.active.getLine(lineNumber - 1);
        if (!line) {
          callback(undefined);
          return;
        }
        const text = line.translateToString(true);
        const links = [...text.matchAll(PATH_RE)].map((m) => {
          const startX = (m.index ?? 0) + 1;
          const token = m[0];
          return {
            range: {
              start: { x: startX, y: lineNumber },
              end: { x: startX + token.length - 1, y: lineNumber },
            },
            text: token,
            activate: (event: MouseEvent) => {
              const reveal = event.metaKey || event.ctrlKey;
              (reveal ? revealPath : openPath)(cwd, token).catch(() => {
                // best-effort
              });
            },
          };
        });
        callback(links.length > 0 ? links : undefined);
      },
    });
```

- [ ] **Step 3: Typecheck and build**

Run: `pnpm check`
Expected: types compile, lint clean, existing tests green. (No unit test — xterm link providers are DOM/terminal-driven; verified live in Step 4.)

- [ ] **Step 4: Live QA**

Launch the app (see `skill: run` / project QA seams). In a Claude session:
1. Have Claude print a file path (e.g. reference a `.md` or `.pdf` in the repo). Hover → it underlines; click → opens in the default app; Cmd-click → reveals in Finder.
2. Print an `http(s)://` URL → click opens the browser.
3. Repeat in the structured view (Tool rows, a Diff header, a backtick path in prose, a URL in prose).
4. **Verify the known macOS WKWebView "two-click" issue** does not make terminal link clicks require two clicks. If it does, note it — link clicks are handled inside the xterm canvas so they're expected to be fine; do not block the feature, but record the finding.

- [ ] **Step 5: Commit**

```bash
git add src/terminal/Terminal.tsx
git commit -m "feat(terminal): clickable URLs and file paths in the terminal"
```

---

## Self-Review

**Spec coverage:**
- Rust `open_path` command + pure resolver + allowlist → Tasks 1, 2. ✓
- Capabilities grant → Task 2 Step 4. ✓
- Bridge helpers → Task 3. ✓
- Structured view (Tool/Diff/Code known paths + Text prose URLs & backtick paths) → Tasks 5, 6. ✓
- Terminal (WebLinksAddon + path provider) → Task 7. ✓
- Open vs Cmd-click reveal → FileLink (Task 5), Text URL (open only), terminal activate (Task 7). ✓
- Web URLs http/https only → `openExternalUrl` (existing), `URL_RE`, WebLinksAddon default. ✓
- Line-suffix stripping, `~` expansion, relative resolution, canonicalize+exists, extension allowlist → Tasks 1-2. ✓
- TDD for pure logic (core resolver, matchers, FileLink, bridge no-op) → Tasks 1,3,4,5,6. ✓
- QA note for WKWebView two-click → Task 7 Step 4. ✓

**Type consistency:** `open_path(cwd, path, reveal)` used identically in bridge (Task 3) and Rust (Task 2). `FileLink({cwd, path, style?, children?})` consumed the same way in Tasks 6 & 5. `cwd` prop added to Tool/Diff/Code/Text and supplied by StudioView. `looksLikePath`/`URL_RE` produced in Task 4, consumed in Tasks 4-test & 6.

**Note on Task 6 Step 6:** `URL_RE` is global; the inline note switches Text.tsx to a non-global `/^https?:\/\//` test to avoid stateful `.test()`. Applied.
