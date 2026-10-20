# Clean code — the Kriyon bar

- **Small, focused units.** One responsibility per function/type/component. If it's hard to name, it's
  doing too much.
- **Meaningful names** over comments. Use the `CONTEXT.md` vocabulary. A comment explains *why*, not *what*.
- **Early returns / guard clauses.** Avoid deep nesting; handle the error/edge case first.
- **Real error handling.** Rust: `Result` + `thiserror`; no `.unwrap()`/`.expect()` in command handlers.
  TS: typed errors, never swallow — no empty `catch`, no fallback that hides a failure.
- **Tolerant at the edges.** The transcript parser degrades unknown input to `Unknown`, never panics.
- **YAGNI.** Build for v1, not a hypothetical. No speculative abstraction: `SessionEngine` stays the
  documented engine contract, and a second engine (`ApiEngine`) waits until it is actually built (ADR 0013).
- **Respect the boundaries.** Frontend never does IO; components never hold business logic; no design
  literals outside `theme/tokens.ts`; all IPC via `src/ipc/bridge.ts`.

## Before you say "done"

- [ ] `pnpm check` is green (lint, types, Vitest, rustfmt, clippy, cargo test).
- [ ] A test was added/updated and it fails without the change.
- [ ] No `.unwrap()`/`.expect()` in a command handler.
- [ ] No hardcoded colors/spacing/status palette outside `theme/tokens.ts`.
- [ ] Inputs crossing the Rust↔JS boundary are validated.
- [ ] Commit message is a conventional commit; on a typed branch off `dev`, not on `dev`/`main`.
