# src (frontend) — agent rules

Read the root `AGENTS.md` first. This is a **thin UI**. The Rust core owns all OS, process and
file work.

## Rules

- **All IPC goes through `src/ipc/bridge.ts`.** Components never call `invoke` or `Channel`
  directly. One file lists every command, so a renamed command breaks in one place.
- **Components render; the store decides.** Derive, parse and fuse in the store (`state/`) or in
  Rust. Logic there is testable without rendering.
- **Colors, spacing and status palettes come from `theme/tokens.ts`.** Literals break themes.
- **Types mirror Rust exactly.** `types.ts` mirrors `StructuredEvent`, `SessionStatus` and the
  event payloads with the same variant names, so a Rust change shows up as a type error here.
- **Test with Vitest and React Testing Library**, failing test first.
- **Log through a logger module.** `console` is a lint error in `src/**`.
