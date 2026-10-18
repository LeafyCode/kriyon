# Contributing to Kriyon

Thanks for helping. This guide covers how to set up, how a change gets in, and the rules for
using AI tools. Deeper rules for the codebase live in [AGENTS.md](AGENTS.md); read it before
your first change.

## Before you start

- **Small fixes** (typos, clear bugs with an obvious fix): open a pull request.
- **Bigger changes** (new features, new dependencies, changes to how sessions or the terminal
  work): open an issue first and wait for a reply. It saves you from building something that
  can't be merged.
- **Questions** go to [GitHub Discussions](https://github.com/LeafyCode/kriyon/discussions).
- **Security problems** go through [SECURITY.md](SECURITY.md), never a public issue.

Issues labelled `good first issue` or `help wanted` are good places to start.

## Set up

You need macOS, [Rust](https://rustup.rs/) (stable), Node.js 22, and
[pnpm](https://pnpm.io/installation).

```sh
git clone https://github.com/LeafyCode/kriyon.git
cd kriyon
pnpm install      # also installs the git hooks
pnpm tauri dev    # run the app with live reload
```

To test a real app build without touching an installed Kriyon, run `pnpm smoke`. It builds and
opens `KriyonSmoke.app`, which keeps its own data.

## Make a change

1. **Branch from `dev`** with a typed name: `feat/…`, `fix/…`, `docs/…`, `refactor/…`, or
   `chore/…`. `main` only receives releases.
2. **Write the test first.** Watch it fail, then make it pass. Pure logic belongs in
   `crates/kriyon-core` with a unit test, or in a Vitest test for the frontend.
3. **Keep it green.** `pnpm check` runs lint, type checks, and every test (TypeScript, Rust and
   the Node scripts).
   It must pass before you push. The git hooks run parts of it for you.
4. **Format, don't hand-format.** `pnpm fix` formats and lints the TypeScript (Biome);
   `cargo fmt --all` formats the Rust.
5. **Commit in small steps** with [conventional commit](https://www.conventionalcommits.org/)
   messages, for example `fix(changes): keep scroll position on reload`.

Working on the website? It has its own checks: `cd website && pnpm check`.

## Open a pull request

- Open it against `dev`.
- **The PR title must be a conventional commit.** PRs into `dev` are squash-merged, so the
  title becomes the commit message. It also drafts the changelog line and picks the next
  version: `feat` for something new a user sees, `fix` for a bug they'd notice.
- Fill in the template: what changed, why, how you tested it, and screenshots for anything
  visible.
- Link the issue it fixes (`Fixes #123`).

### How review works

A maintainer reviews every pull request. CI must pass first. Expect questions; they're how we
keep the code readable for the next person. If a PR goes quiet for a while, a polite nudge is
fine.

## Using AI tools

AI help is fine. The rules:

- **You own every line**, whoever or whatever typed it. Read it, run it, test it, and be able
  to explain it in review.
- **Say so in the PR if AI wrote most of the change.** The PR template has a checkbox for this.
  It's not a mark against you; it tells the reviewer where to look harder.
- **No fully automated pull requests.** A bot or agent may not open PRs, issues, or review
  replies on its own. A person must write and send them.
- Don't paste output you haven't checked into issues or discussions.

PRs that break these rules are closed.

If you use an AI coding agent, point it at [AGENTS.md](AGENTS.md). It holds the codebase rules
in a form agents read well. How the team works with Claude Code (the skills, the review agents,
the safety hook, and the model and effort we use) is in [docs/AI.md](docs/AI.md).

## Code of Conduct

Everyone taking part agrees to the [Code of Conduct](CODE_OF_CONDUCT.md).

## License

Kriyon is licensed under the [Apache License 2.0](LICENSE). By sending a contribution, you
agree it is licensed under the same terms (section 5 of the licence). There is no separate
contributor agreement to sign.
