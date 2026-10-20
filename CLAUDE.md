`AGENTS.md` (imported below) is the rulebook for every AI tool. Load the skill a rule points at.

Five things we keep getting wrong here:

1. **Run `pnpm fix` to format**, then fix by hand only what it can't. Hand formatting fights
   Biome and fails the commit hook.
2. **Push with `env -u KRIYON_TTY -u CLAUDE_PID git push`** when you run inside a Kriyon
   terminal. Otherwise the pre-push tests think they run in a hosted session and fail.
3. **In a fresh worktree, run `node scripts/sidecar-ptyd.mjs` before any Rust build.** Tauri
   needs the daemon binary in `src-tauri/binaries/`, and pre-push fails without it.
4. **Match file names exactly, including case.** macOS ignores case, so `tsc` passes locally on
   two files that differ only by case; Linux CI then fails.
5. **`pr-review` and `pr-fix` run only when the person asks.** Offer once after opening a pull
   request, then wait. Both post to GitHub under their name.

@AGENTS.md
