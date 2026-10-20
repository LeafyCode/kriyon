# Release cycle — design

Date: 2026-09-09
Status: proposed (awaiting approval)

Kriyon has never cut a release. There are no git tags, the DMG is built by hand on
one Mac from a gitignored `.env`, and nothing has ever been published to GitHub.
The website's Download button already points at `/releases`, which is empty.

This design makes releases automatic, reproducible, and safe to hand to strangers
once the repo goes public.

## What was verified before writing this

Every claim below was checked against the repo, not assumed:

| Claim | Result |
| --- | --- |
| `git tag` is empty | true — no baseline for "changes since last release" |
| `src-tauri/Cargo.toml` version | `0.1.0`, while `package.json` says `0.8.0` |
| `beforeBuildCommand` passes the build target to the sidecar | **no** — `sidecar-ptyd.mjs` falls back to the host triple unless `KRIYON_SIDECAR_TARGET` is exported |
| capabilities grant updater/process permissions | no — `default.json` and `tray.json` have neither |
| a secret was ever committed (`.env`, `.p8`, `.p12`, `.cer`, `.key`) | **none, ever** — history is clean, no rewrite needed |
| `release-mac.sh` fails when no DMG is produced | no — the `nullglob` loop runs zero times and exits 0 |
| `latest.json` platform keys | `darwin-aarch64` / `darwin-x86_64` — no universal key |
| CI token permissions | `contents: read` — releases need job-scoped write |

Two claims from the Codex review did **not** hold up:

- Tauri's docs do use `darwin-universal` (not `macos-universal`) as the custom
  updater target string. The advice was still right for the wrong reason: don't
  set a custom target at all, because `tauri-action` writes the two standard
  darwin keys and would not know about a custom one.
- Git history needs no secret purge. Nothing sensitive was ever committed. The
  signing identity and Team ID in `.env.example` are printed on every signed
  binary — public certificate metadata, not secrets.

## The flow

1. Feature work lands on `dev` via PRs. Unchanged.
2. `pnpm release 0.9.0` on `dev` — bumps every version, drafts a changelog entry,
   creates `chore/release-0.9.0`.
3. A human rewrites the draft into prose and deletes the `<!-- RELEASE_DRAFT -->`
   marker. Push, open a PR into `main`.
4. Merging that PR builds and publishes. The release only becomes visible once
   every artifact has been verified.
5. Done. The website already links to it.

## Phase 0 — Groundwork

Nothing else can work until these land.

- **Tag `v0.8.0` at `a1da054`** (the `chore(release): 0.8.0` commit), annotated,
  pushed. This is the baseline every future "what changed" query counts from.
- **Fix the version drift.** `src-tauri/Cargo.toml` goes `0.1.0` → `0.8.0`, and
  `Cargo.lock` with it. `kriyon-core` and `kriyon-ptyd` stay at `0.1.0` — they are
  internal crates, never published, and tying them to the app version is noise.
- **Adopt the draft marker.** A generated changelog section carries
  `<!-- RELEASE_DRAFT -->` directly under its heading. Removing that line is what
  "I edited this" means. CI checks for the literal string; it never tries to judge
  whether prose is good.

## Phase 1 — Publish pipeline

### `scripts/release.mjs`

`pnpm release 0.9.0`. Refuses to run unless the tree is clean, the branch is `dev`,
and the new version is higher than the current one. Then it:

- writes the version to `package.json`, `src-tauri/Cargo.toml`, `Cargo.lock`, and
  `APP_VERSION` in `website/src/lib/site.ts` — one command, four files, no drift
- drafts a `## 0.9.0 — YYYY-MM-DD` section from the PR titles in
  `gh api repos/LeafyCode/kriyon/compare/v0.8.0...dev`, with the draft marker under
  the heading
- creates `chore/release-0.9.0` and commits

The draft is a **checklist, not prose**. Squash and rebase merges break the
commit-to-PR mapping, so the generated list will sometimes miss or misattribute an
entry. A human is rewriting it anyway.

### `.github/workflows/release.yml`

Triggered on `push` to `main`. Three jobs, secrets only in the last two.

`concurrency: { group: release, cancel-in-progress: false }` — two merges in quick
succession must never race over the same tag and `latest.json`.

**`gate`** — ubuntu, no secrets:
- reads the version from `package.json`
- exits cleanly (not a failure) if `v$VERSION` is already tagged **and** its release
  is published — this is what makes an ordinary non-release push to `main` a no-op
- asserts `Cargo.toml`, `site.ts`, and the CHANGELOG heading all agree
- asserts the version's changelog section exists, is non-empty, and no longer
  contains `<!-- RELEASE_DRAFT -->`
- calls the existing `ci.yml` via `workflow_call` so the full test suite passes on
  this exact commit before any secret is exposed

**`build`** — `macos-15` (pinned, not `macos-latest`), `needs: gate`,
`environment: release` so the Apple secrets exist nowhere else:
- imports the `.p12` into a temporary keychain, adds it to the search list, runs
  `set-key-partition-list`, verifies the identity is present
- writes the `.p8` to a `600` temp file
- `export KRIYON_SIDECAR_TARGET=universal-apple-darwin` — **without this the
  sidecar builds host-only and the universal bundle fails**
- `rustup target add aarch64-apple-darwin x86_64-apple-darwin`, `KRIYON_CARGO_JOBS`
  capped (thin LTO across two architectures is memory-hungry on a runner)
- `tauri-action` pinned to a commit SHA, matching how `ci.yml` already pins
  everything, with `--target universal-apple-darwin`, `releaseDraft: true`,
  `tagName: v__VERSION__`, and the changelog section as the release body
- then, before anything is visible: notarize and staple the DMG (Tauri notarizes
  the `.app` but not the DMG), assert exactly one DMG and one updater
  archive/signature pair exist, `lipo -archs` both the app binary and the sidecar,
  `codesign --verify --deep --strict`, `spctl -a -vv`, `stapler validate`

**`publish`** — flips the draft release to published. Last operation, nothing else
after it.

`scripts/release-mac.sh` keeps working for local builds. Only the DMG notarize step
is extracted into `scripts/notarize-dmg.sh`, taking credentials from the environment
and a DMG path as an argument — a narrow helper, not a CI abstraction. Its silent
"zero DMGs is fine" bug gets fixed in both callers.

### Rerun rules

- The tag always points at the commit that triggered the build.
- A failed build leaves a draft release; rerunning resumes it.
- A published release and its tag are immutable. A mistake ships as a new patch
  version. Nothing ever moves a tag.

## Phase 2 — Open source, then go public

Order matters: all of this exists **before** the repo is visible.

- `LICENSE` — **open question, see below**
- `README.md` — currently the untouched Tauri scaffold template
- `CONTRIBUTING.md`, `SECURITY.md`, issue and PR templates
- **Branch protection on GitHub itself.** Lefthook only protects developers who ran
  `pnpm install`. It does nothing about a stranger pushing to `main`.
- Confirm no workflow triggered by `pull_request` can reach a release secret, and
  that `pull_request_target` is used nowhere. Merged code runs `pnpm install`, Cargo
  build scripts, and `beforeBuildCommand` in the same job as the signing key — the
  `release` environment plus a `push: main`-only trigger is the boundary.

No history rewrite is needed; the audit above found nothing.

Making the repo public also makes macOS runner minutes free. Until then each
release costs real money.

## Phase 3 — Auto-update (its own feature, its own spec)

Moved last, because it is not release plumbing.

**Restarting Kriyon is a product decision.** The app already has deliberate
machinery for "you have live terminals and unsaved work" — `src-tauri/src/quit.rs`
and `src/terminal/closeOnQuit.ts`. A bare `relaunch()` walks straight past it and
kills whatever Claude was doing. The update flow must route through the existing
confirmation and terminal teardown, or it is a data-loss bug wearing a feature's
clothes.

The rest:

- Update checking is network access and restarting is process control, so both live
  in Rust behind typed commands in `src/ipc/bridge.ts`, per the architecture rule.
  `tauri-plugin-process` is unnecessary — Rust calls `app.restart()`.
- `capabilities/default.json` needs the updater permissions it currently lacks.
- No custom updater target. `tauri-action` writes `darwin-aarch64` and
  `darwin-x86_64`; a `darwin-universal` override would produce a key nothing reads.
  Verify the generated `latest.json` by hand on the first release.
- The updater downloads the `.app.tar.gz`, never the DMG. The `.app` must be signed,
  notarized, and stapled *before* that archive is built. `latest.json` carries the
  literal contents of the `.sig` file, not a link to it.
- Endpoint: `https://github.com/LeafyCode/kriyon/releases/latest/download/latest.json`.
  One stable channel, no staged rollout. A broken release is fixed by shipping a
  higher patch version.
- **The signing key is forever.** Lose it and every installed copy is stranded — a
  new key cannot be trusted by an app that only knows the old one. Generate it,
  back it up encrypted and offline, and write the rotation procedure down before
  the first release that uses it.
- **0.9.0 cannot update anybody.** Everyone on 0.8.0 downloads once by hand. The
  real test is 0.9.0 → 0.9.1, done for real before claiming this works.
- Test as a standard (non-admin) user, from `/Applications` and from
  `~/Applications`. Replacing an app in `/Applications` fails in several ordinary
  situations. Always leave a "download it yourself" fallback in the UI.

## Deliberately not doing

- Downloading every uploaded asset back from GitHub and re-verifying its bytes
  against the advertised signature. Real failure mode, wrong cost for one
  maintainer; the local `stapler validate` and `spctl` checks catch the cases that
  actually happen.
- Release channels, staged rollout, or rollback machinery.
- Auto-generating changelog prose.

## Open question

**Which license?** MIT is the ordinary default and the one to pick absent a reason.
If Kriyon should not be repackaged and sold, that is a different answer and worth a
conversation before Phase 2. This blocks nothing until then.
