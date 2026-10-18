---
name: engineering-workflow
description: Use when implementing any Kriyon feature or fix — the idea→shipped loop (understand, test-first, implement, keep green, commit, open the PR) and the clean-code bar this repo holds to.
---

# Engineering workflow

The loop for every change in Kriyon. Keep it lean — build the simplest thing that meets v1.

1. **Understand.** Read the relevant spec/plan section and the surrounding code. Confirm the domain
   term exists in the glossary (`CONTEXT.md` indexes `docs/context/`). If touching a library API,
   verify it against current docs (context7).
2. **Test first (TDD).** Write the failing test. Run it, watch it fail for the right reason. Pure
   logic → a `kriyon-core` unit test or a Vitest test; never test through the Tauri shell what can be
   tested in the core.
3. **Implement** the smallest change that makes the test pass. Respect the boundaries: Rust core owns
   IO; the frontend is a thin UI calling `src/ipc/bridge.ts`; design values come from `theme/tokens.ts`.
4. **Keep it green.** `pnpm check` (lint + types + Vitest + rustfmt + clippy + cargo test) must pass.
5. **Commit** small, with a conventional message, on a typed branch off `dev`; merge back by PR. Let
   lefthook + commitlint run; never `--no-verify`.
6. **Ship.** Push and open the pull request into `dev` as `shipping.md` in this skill says: the
   title rules, the template, and what happens before a person reviews.

For the quality bar — naming, error handling, YAGNI, and the "before you say done" checklist —
see `clean-code.md` in this skill.
