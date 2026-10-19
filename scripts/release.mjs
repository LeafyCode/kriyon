#!/usr/bin/env node
// Versions and the changelog for Kriyon. See ADR 0045 and the `release` skill.
//
//   pnpm release [x.y.z] [--notes <file>]
//       Cut a release from an up-to-date dev: make chore/release-x.y.z, set
//       the version everywhere, add the CHANGELOG.md entry and commit. The
//       version defaults to what git-cliff picks from the commits. Without
//       --notes the draft entry opens in $EDITOR to be rewritten in plain words.
//       Every check runs before the branch is made. Nothing is pushed.
//   pnpm release next               Print the next release version.
//   pnpm release draft [x.y.z]      Print git-cliff's draft entry.
//   pnpm release beta [--write]     Print the next beta (x.y.z-beta.N).
//   pnpm release nightly [--run N] [--date <ISO time>] [--write]
//       Print the nightly version (x.y.z-nightly.YYYYMMDD.N). N defaults to
//       $GITHUB_RUN_NUMBER; the date, the UTC day of --date, to now. CI passes
//       the run's start time, so a re-run after midnight keeps its version.
//       --write sets that version in the working tree for a build; no commit.
//       Read the version with `node scripts/release.mjs …`: pnpm prints a
//       banner of its own on stdout.
//   node scripts/release.mjs released [--no-fetch]
//       For the release workflow, once the release PR reaches main: check
//       that main took what the entry lists and print the commit to tag
//       v<version>. Tags nothing; publishing the release makes the tag.
//       --no-fetch uses the branches and tags already fetched.
//   node scripts/release.mjs notes <version>
//       Print the release notes: a release's CHANGELOG.md entry, or for a
//       beta or nightly git-cliff's draft of what is new since the previous
//       one on its channel, both without heading or comments.

import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  betaVersion,
  changelogEntry,
  channelOf,
  cleanEntry,
  draftNotes,
  insertChangelogEntry,
  isNewer,
  listsChanges,
  nextRelease,
  nightlyVersion,
  notesSince,
  preReleaseBase,
  readTagPattern,
  readVersions,
  setVersions,
  VERSION_FILES,
} from "./release-lib.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CHANGELOG = "CHANGELOG.md";

const WHITESPACE = /\s+/;

const read = (path) => readFileSync(join(repoRoot, path), "utf8");
const write = (path, text) => writeFileSync(join(repoRoot, path), text);

const run = (cmd, args) =>
  execFileSync(cmd, args, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
const git = (...args) => run("git", args);
// git-cliff logs to stderr; only its stdout is the answer.
const cliff = (...args) =>
  run(join(repoRoot, "node_modules", ".bin", "git-cliff"), args);

const fail = (message) => {
  console.error(`\n✗ ${message}\n`);
  process.exit(1);
};
// Progress goes to stderr, so stdout carries only the answer (a version).
const ok = (message) => console.error(`  ✓ ${message}`);

const tags = () => git("tag", "--list").split("\n").filter(Boolean);
const tagPattern = () => readTagPattern(read("cliff.toml"));
const versionFiles = () =>
  Object.fromEntries(
    Object.entries(VERSION_FILES).map(([key, path]) => [key, read(path)])
  );
const writeVersionFiles = (files) => {
  for (const [key, path] of Object.entries(VERSION_FILES)) {
    write(path, files[key]);
  }
};

const next = () => nextRelease(cliff("--bumped-version"), tags(), tagPattern());
const base = () =>
  preReleaseBase(cliff("--bumped-version"), tags(), tagPattern());

const setVersion = (version) => {
  writeVersionFiles(setVersions(versionFiles(), version));
  ok(`Set ${version} in package.json, Cargo.toml, Cargo.lock and the website`);
};

const editInEditor = (draft) => {
  const editor = process.env.VISUAL || process.env.EDITOR || "vi";
  const dir = mkdtempSync(join(tmpdir(), "kriyon-release-"));
  const file = join(dir, "ENTRY.md");
  const guide = [
    "<!--",
    "  Rewrite this in plain words for someone using Kriyon, in the voice of the",
    "  entries already in CHANGELOG.md: a short summary paragraph, then bold",
    "  lead-ins that say what changed for them. Drop lines nobody would notice.",
    "  Comments are removed. Save and quit to continue; empty it to stop.",
    "-->",
    "",
  ].join("\n");
  writeFileSync(file, `${guide}${draft}\n`);
  const [cmd, ...args] = editor.split(WHITESPACE);
  const result = spawnSync(cmd, [...args, file], { stdio: "inherit" });
  const text = readFileSync(file, "utf8");
  rmSync(dir, { recursive: true, force: true });
  if (result.status !== 0) {
    fail(`${editor} exited with status ${result.status}; nothing changed.`);
  }
  return text;
};

const releaseBranchReady = () => {
  if (git("status", "--porcelain", "--untracked-files=no")) {
    fail("Commit or stash your changes first.");
  }
  git("fetch", "--quiet", "--tags", "origin", "dev", "main");
  if (git("rev-parse", "HEAD") !== git("rev-parse", "origin/dev")) {
    fail("Cut a release from an up-to-date dev: git switch dev && git pull");
  }
};

const branchExists = (branch) =>
  spawnSync(
    "git",
    ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`],
    {
      cwd: repoRoot,
    }
  ).status === 0;

const cut = (requested, notesFile) => {
  releaseBranchReady();
  const files = versionFiles();
  const current = readVersions(files)["package.json"];
  const version = requested ?? next();
  if (!version) {
    fail(
      `Nothing to release since v${current}: git-cliff found no commit that calls for one. Pass a version to release anyway.`
    );
  }
  if (!isNewer(version, current)) {
    fail(`${version} is not after the current version ${current}.`);
  }
  if (tags().includes(`v${version}`)) {
    fail(`Tag v${version} already exists.`);
  }
  const branch = `chore/release-${version}`;
  if (branchExists(branch)) {
    fail(`Branch ${branch} already exists.`);
  }
  console.error(`\nKriyon ${current} → ${version}\n`);

  // Everything that can refuse runs here, before the branch or any file
  // changes: the entry, and every version line.
  const draft = cliff("--unreleased", "--tag", `v${version}`, "--strip", "all");
  const entry = cleanEntry(
    notesFile ? readFileSync(resolve(notesFile), "utf8") : editInEditor(draft),
    version
  );
  const updated = setVersions(files, version);
  const changelog = insertChangelogEntry(read(CHANGELOG), entry);

  git("switch", "--quiet", "-c", branch);
  ok(`Made ${branch}`);
  writeVersionFiles(updated);
  write(CHANGELOG, changelog);
  ok(`Set ${version} everywhere and added the CHANGELOG.md entry`);
  git("add", CHANGELOG, ...Object.values(VERSION_FILES));
  // Inherit stdio so the commit hooks' output shows.
  const commit = spawnSync(
    "git",
    ["commit", "--quiet", "-m", `chore(release): ${version}`],
    { cwd: repoRoot, stdio: "inherit" }
  );
  if (commit.status !== 0) {
    fail(
      `The commit failed; the release changes are staged on ${branch}. Fix what the hook reported, then run: git commit -m "chore(release): ${version}"`
    );
  }
  ok(`Committed chore(release): ${version}`);

  console.error(`
Next:
  1. Push ${branch} and open a PR into dev titled "chore(release): ${version}".
  2. Once it's merged, open the release PR from dev into main.
  3. Once that's merged, the release workflow builds a draft release. Check
     it, then run the Publish workflow; publishing makes the tag.
`);
};

// The commit main's release tag goes on, after the checks. Prints its SHA.
const released = (fetch) => {
  if (fetch) {
    git("fetch", "--quiet", "--tags", "origin", "dev", "main");
  }
  // The dev commit main last took. Tagging it (not main's merge commit) keeps
  // the tag reachable from dev, where git-cliff counts commits from it.
  const commit = git("merge-base", "origin/main", "origin/dev");
  if (git("diff", "--name-only", commit, "origin/main")) {
    fail(
      `origin/main has changes that dev at ${commit.slice(0, 7)} doesn't. Merge dev into main first.`
    );
  }
  const { version } = JSON.parse(git("show", `${commit}:package.json`));
  const name = `v${version}`;
  if (tags().includes(name)) {
    fail(`${name} already exists.`);
  }
  const releaseCommit = git(
    "log",
    "-1",
    "--format=%H",
    "--fixed-strings",
    "--grep",
    `chore(release): ${version}`,
    commit
  );
  if (!releaseCommit) {
    fail(`No "chore(release): ${version}" commit in what main took.`);
  }
  // A change merged into dev after the release commit shipped in this release
  // but isn't in its entry, and git-cliff would never list it later.
  const unlisted = cliff(`${releaseCommit}..${commit}`, "--strip", "all");
  if (listsChanges(unlisted)) {
    fail(
      `main took changes made after "chore(release): ${version}" that its entry doesn't list:\n\n${unlisted}\n\nAdd them to the ${version} entry in CHANGELOG.md in a pull request into dev titled "chore(release): ${version}", then take dev into main again.`
    );
  }
  ok(`${name} goes on ${git("log", "-1", "--format=%h %s", commit)}`);
  console.log(commit);
};

const nightlyDate = (value) => {
  const date = value === undefined ? new Date() : new Date(value);
  if (Number.isNaN(date.getTime())) {
    fail(`--date must be a date and time, got "${value}"`);
  }
  return date;
};

// git-cliff only counts from release tags (cliff.toml), so a range starts it
// from the last pre-release of the channel instead. --unreleased would drop
// the range, and isn't needed: no release tag can fall inside it.
const preReleaseDraft = (version) => {
  const since = notesSince(version, tags());
  const range = since === undefined ? ["--unreleased"] : [`${since}..HEAD`];
  return cliff("--tag", `v${version}`, "--strip", "all", ...range);
};

const notes = (version) =>
  channelOf(version) === "stable"
    ? changelogEntry(read(CHANGELOG), version)
    : draftNotes(preReleaseDraft(version));

const main = () => {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    allowNegative: true,
    options: {
      date: { type: "string" },
      fetch: { type: "boolean", default: true },
      notes: { type: "string" },
      run: { type: "string", default: process.env.GITHUB_RUN_NUMBER },
      write: { type: "boolean", default: false },
    },
  });
  const [command, arg] = positionals;

  const printOrWrite = (version) => {
    if (values.write) {
      setVersion(version);
    }
    console.log(version);
  };

  switch (command) {
    case "next":
      console.log(next() ?? "nothing to release");
      break;
    case "draft":
      console.log(
        cliff("--unreleased", "--tag", `v${arg ?? base()}`, "--strip", "all")
      );
      break;
    case "beta":
      printOrWrite(betaVersion(base(), tags()));
      break;
    case "nightly":
      if (!values.run) {
        fail(
          "A nightly needs a run number. Pass --run N or set GITHUB_RUN_NUMBER."
        );
      }
      printOrWrite(
        nightlyVersion(base(), nightlyDate(values.date), values.run)
      );
      break;
    case "released":
      released(values.fetch);
      break;
    case "notes":
      process.stdout.write(notes(arg ?? ""));
      break;
    default:
      // `pnpm release` or `pnpm release 0.13.0`.
      cut(command, values.notes);
  }
};

try {
  main();
} catch (error) {
  fail(error.stderr?.toString().trim() || error.message);
}
