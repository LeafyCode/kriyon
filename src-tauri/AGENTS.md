# src-tauri — agent rules

Read the root `AGENTS.md` first. This is the thin Tauri shell: daemon client (the PTY itself lives
in `crates/kriyon-ptyd`), file watcher, commands, persistence, notifications. **Pure, testable logic belongs in `crates/kriyon-core`, not here.**

## The one right way to add a Tauri command

1. Put the command in `commands.rs` as `#[tauri::command]`.
2. Register it in `lib.rs` inside `tauri::generate_handler![…]`.
3. **Validate every input** — it crossed the trust boundary from the webview.
4. Keep the decision logic in `kriyon-core` and unit-test it there; the command is just glue.
5. Return `Result<_, String>` (or a typed error) — propagate, don't panic.
6. `cargo clippy --all-targets -- -D warnings` and `cargo test` green.

## Hard rules — ask before breaking

- Changing the `tauri::ipc::Channel` byte-stream contract or a JSON event shape (the frontend
  mirrors these in `src/types.ts`).
- Editing `capabilities/default.json` permissions (especially the `~/.claude` fs scope).
- `.unwrap()` / `.expect()` in a command handler — use `Result` + `thiserror`. (`expect` is allowed in tests.)
- PTY streaming must stay binary + batched over a `Channel`. No per-keystroke JSON IPC.
