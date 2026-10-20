# Shipping — from a green branch to a merged pull request

Read this when the change is committed and `pnpm check` is green.

## 1. Push

```sh
env -u KRIYON_TTY -u CLAUDE_PID git push -u origin <branch>
```

Pre-push runs the tests. Unset those two variables when you run inside a Kriyon terminal, or
the tests think they run in a hosted session. A push that fails pre-push is a real failure:
fix it, never skip it.

## 2. Open the pull request into `dev`

```sh
gh pr create --base dev --title "<type>(<scope>): <subject>" --body-file <file>
```

Write the body to a file first, the same as a commit message.

**The title is the commit.** Pull requests into `dev` are squash-merged, so the title becomes
the one commit on `dev`, and the changelog and version bump are built from it. CI
(`pr-title.yml`) checks it:

- `<type>` is one of `feat`, `fix`, `perf`, `refactor`, `docs`, `test`, `build`, `ci`,
  `chore`, `style`, `revert`. `feat` and `fix` are what users see in the changelog, so use them
  only for a change a user notices. They also pick the next version (`cliff.toml`, ADR 0045):
  `feat` bumps the minor number, `fix` the patch, and a `!` after the type (`feat!:`) marks a
  breaking change, which bumps the minor number until 1.0.
- `<scope>` is optional: the area, e.g. `changes`, `sidebar`, `ptyd`, `hooks`, `skills`.
- `<subject>` starts lower-case, says what the change does in plain words, and has no full
  stop: `fix(changes): keep scroll position on reload`.

## 3. Fill in the template

`.github/pull_request_template.md` has four parts. Fill every one; a reviewer reads the body
before the diff.

- **What changed**: the behaviour, not a file list.
- **Why**: the problem, and `Fixes #123` when there is an issue.
- **How I tested it**: the tests you added and what you checked by hand. A screenshot or a
  recording for anything visible.
- **Checklist**: tick only what is true. Tick "AI tools wrote most of this change" when they
  did. It tells the reviewer where to look harder.

End the body with the `🤖 Generated with [Claude Code](https://claude.com/claude-code)` line
when an agent wrote it.

## 4. Before asking a person to review

Offer to run `/pr-fix <n>` on the pull request, then wait for the person to say so. It reviews,
fixes and re-checks until it comes back clean. Merging, labels and GitHub settings are the
person's call.
