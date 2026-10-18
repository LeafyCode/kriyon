---
name: release
description: Cut a Kriyon release — pick the version, rewrite the changelog entry in plain words, open the release PRs, publish the draft. Use for "release Kriyon", "cut 0.13.0", "publish the release".
disable-model-invocation: true
argument-hint: "<version, or nothing to let git-cliff pick; \"publish\" once the release PR is on main>"
---

# Release

`scripts/release.mjs` does the mechanics (its header comment lists the commands); you
write the changelog entry and walk the person through the gates. The model is in ADR 0045 and
ADR 0046: one version everywhere, picked by git-cliff from the commit titles on `dev`; once
`main` has it, CI builds a draft release, and publishing the draft makes the tag.

Every push, pull request and publish waits for the person's yes. Each one is outward-facing.
Given `publish`, go straight to step 5; given a version, use it in steps 2 and 3.

## 1. Start from an up-to-date `dev`

`git switch dev && git pull`, with no uncommitted tracked changes. `pnpm release next` prints
the version git-cliff picks. If it says nothing to release, stop and tell the person; they can
still name a version.

## 2. Write the entry

`pnpm release draft [<version>]` prints git-cliff's draft: a heading, then commit titles
grouped as Added, Changed, Removed, Fixed and Security, with outside contributors thanked by
name. Rewrite it into the voice of the newest entry in `CHANGELOG.md`, which is the model:

- Keep the heading exactly: `## <version> — <YYYY-MM-DD>`, today's date.
- One short summary paragraph: what this release means for someone using Kriyon.
- Each line opens with a **bold lead-in** that names the change as a user sees it, then a
  sentence or two in plain words. Merge lines that are one change; drop lines nobody would
  notice; keep every thank-you.
- Groups in Keep a Changelog order; leave out empty ones.

Write it to a file in your scratchpad and show it to the person. The step is done when they
say the entry is right.

## 3. Cut it

```sh
pnpm release [<version>] --notes <entry file>
```

It makes `chore/release-<version>` from `dev`, sets the version in `package.json`,
`Cargo.toml`, `Cargo.lock` and the website, adds the entry to `CHANGELOG.md` and commits
`chore(release): <version>`. A refusal names what to fix; every check runs before the branch
is made, so a refusal changes nothing. If the commit hook fails, the changes stay staged on
the branch: fix what it reported and commit with the same message.

## 4. The two pull requests

With the person's yes, push the branch (`env -u KRIYON_TTY -u CLAUDE_PID git push -u origin
<branch>`) and open a PR into `dev` titled `chore(release): <version>`, as
`engineering-workflow/shipping.md` says. After it's merged, offer to open the release PR from
`dev` into `main`, titled `chore(release): <version>`, its body the changelog entry.
`docs/AI.md` asks for `/code-review ultra` on that PR; remind the person. Merging is theirs.

## 5. Publish

Merging the release PR into `main` starts the Release workflow (`.github/workflows/release.yml`).
It checks that `main` took only what the entry lists, builds and notarizes the app, and leaves
a draft release `v<version>` whose update feed has passed its check. Watch it with
`gh run watch`. If it refuses because `main` took a change the entry doesn't list, tell the
person: the fix is a `chore(release): <version>` PR into `dev` that adds it to the entry,
then `dev` into `main` again.

Once the draft is up, the person checks it on GitHub. They can edit the notes there. The
version is built into the app, so changing it means deleting the draft and starting again at
step 1. With their yes, run the Publish workflow on `main`:
`gh workflow run publish.yml --ref main -f tag=v<version>`. It checks the feed again,
publishes the release (GitHub makes the tag then), moves the feeds and bumps the Homebrew tap.
`docs/RELEASING.md` covers failures.

Betas and nightlies are numbered by the same script (`pnpm release beta`,
`pnpm release nightly --run <n>`) and built and published by the Release workflow; they need
no entry and no PR. A beta starts with `gh workflow run release.yml --ref dev -f channel=beta`,
after the person's yes.
