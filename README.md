# Kriyon

A Mac app for running Claude Code. Kriyon hosts your own signed-in `claude` CLI in a real
terminal and puts a Changes view beside it, so you can read what each session did to your files.
Every session uses your own Claude plan and its usage limits.

<!-- TODO(release): add a screenshot here, taken from a demo project with no real project names or home paths. -->

## What it does

- **A real terminal per session.** `claude` runs exactly as it does in your own terminal. The
  terminal is the source of truth; Kriyon reads around it and never answers for you.
- **A Changes view.** A diff of every file the session touched, measured from when the session
  started, so two sessions on the same checkout don't show each other's work.
- **Many sessions at once.** A sidebar of projects and sessions, with clear status for the ones
  that need you, plus notifications and a menu-bar view.
- **Worktrees.** Start a session on its own git worktree and merge it back when it's done.

The full list is in [FEATURES.md](FEATURES.md).

## Install

Kriyon needs macOS 13 or later and the [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code)
installed and signed in.

- **Download:** get the latest signed DMG from
  [Releases](https://github.com/LeafyCode/kriyon/releases/latest).
- **Homebrew:** `brew install leafycode/tap/kriyon`
- **Build from source:** see below.

## Build from source

You need macOS, [Rust](https://rustup.rs/) (stable), Node.js 22, and
[pnpm](https://pnpm.io/installation).

```sh
git clone https://github.com/LeafyCode/kriyon.git
cd kriyon
pnpm install
pnpm tauri dev    # run the app with live reload
pnpm smoke        # build and open a separate test copy (KriyonSmoke.app)
pnpm check        # lint, types, and all tests
```

The test copy uses its own bundle id, so it never touches the data of a Kriyon you installed.
It is unsigned, so macOS notifications won't show unless you sign it (`pnpm smoke --sign`, which
reads your own Developer ID from `.env`; see `.env.example`).

## How Kriyon treats Claude Code

- Kriyon runs the `claude` CLI you installed. It never bundles, patches, or replaces it.
- You sign in through Anthropic's own flow. Kriyon never reads, stores, or moves your
  credentials.
- Kriyon has no accounts and no servers of its own.

The reasoning is in [ADR 0030](docs/adr/0030-never-touch-credentials-or-bundle-the-cli.md).

## Contributing

Bug reports, ideas, and pull requests are welcome. Start with [CONTRIBUTING.md](CONTRIBUTING.md).

- Questions: [GitHub Discussions](https://github.com/LeafyCode/kriyon/discussions)
- Help and where to ask: [SUPPORT.md](SUPPORT.md)
- Security problems: [SECURITY.md](SECURITY.md). Please don't open a public issue.
- Everyone taking part agrees to the [Code of Conduct](CODE_OF_CONDUCT.md).

## Disclaimer

Kriyon is an independent open-source project. It is not affiliated with, endorsed by, or
sponsored by Anthropic. Claude and Claude Code are trademarks of Anthropic, PBC. Kriyon runs
your own, unmodified Claude Code install; you sign in through Anthropic's own flow and your use
is governed by your agreement with Anthropic.

## License

Kriyon, including the Kriyon Companion mod, is licensed under the [Apache License 2.0](LICENSE).
Kriyon is made by [LeafyCode](https://leafycode.com/).

### Third-party fonts

- [Geist](https://vercel.com/font), SIL Open Font License 1.1
  ([licence](public/fonts/Geist-LICENSE.txt))
- [JetBrains Mono Nerd Font](https://www.nerdfonts.com/), SIL Open Font License 1.1
  ([licence](public/fonts/JetBrainsMono-LICENSE.txt))
