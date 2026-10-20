# Settled arguments

Specific points a review raised that a maintainer rejected as false alarms. The scorer
throws out any finding that matches an entry here, without spending a score on it. If you
think an entry is wrong, say so once in the summary's **Notes** — never as an inline comment.

The list starts empty on purpose. The general rules for what is not a finding (pre-existing
problems, lint, taste, intentional changes, disagreeing with an ADR) live in `engine.md`
step 2, and the rules for what *is* one live in `AGENTS.md` and `repo-rules.md`. Writing
guesses here in advance would silence real findings before anyone saw them. An entry earns
its place by being a real false alarm.

## Adding an entry

Only a maintainer adds an entry, after rejecting a posted comment. A review run never
edits this file.

- **Narrow.** It names the exact pattern and paths, not a whole category. "Linux-only `cfg`
  branches in `src-tauri/src/tray.rs` do less on purpose" — not "ignore platform code".
  A broad entry teaches the reviewer to skip the next real bug of that kind.
- **Sourced.** It links the rejected comment, and the ADR or doc that settles it if there is
  one. If the decision is big enough to need explaining, write the ADR first and point here.
- **Dated, with an end.** Say what would make it stale, so it can be removed. An entry whose
  code or ADR has changed is deleted, not left to drift.
- **Numbered once.** Numbers are never reused or reordered, so a reference to P3 always
  means the same entry.

```markdown
### P1 — <the point, as the reviewer would raise it>

- **Not a finding because:** <one line> (<ADR, doc or code that settles it>)
- **Applies to:** <paths or pattern>
- **Raised in:** <link to the rejected comment> · **Added:** <YYYY-MM-DD>
- **Revisit when:** <what would make this stale>
```

## Entries

None yet.
