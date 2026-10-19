// Pure helpers for scripts/release.mjs: reading and setting the one version,
// choosing the next one, pre-release numbers and the changelog entry. No IO
// here, so they're tested directly (scripts/release.test.mjs).

const RUN_NUMBER = /^(0|[1-9]\d*)$/;
const RELEASE = /^(\d+)\.(\d+)\.(\d+)$/;
// The shapes betaVersion and nightlyVersion write, read back by channelOf.
const BETA = /^\d+\.\d+\.\d+-beta\.\d+$/;
const NIGHTLY = /^\d+\.\d+\.\d+-nightly\.\d{8}\.\d+$/;
const LEADING_V = /^v/;
const LOCK_PACKAGE_SEPARATOR = /\n(?=\[\[package\]\]\n)/;
const LOCK_NAME = /^name = "([^"]+)"$/m;
const LOCK_VERSION = /^(version = ")([^"]+)(")$/m;
const LOCK_SOURCE = /^source = /m;
const TAG_PATTERN = /^tag_pattern\s*=\s*"((?:[^"\\]|\\.)*)"$/m;
const TOML_ESCAPE = /\\(.)/g;
const COMMENT = /<!--[\s\S]*?-->\n?/g;
const BLANK_RUN = /\n{3,}/g;
const CHANGE_GROUP = /^### /m;
const HEADING_LINE = /^## .*\n?/;

const PACKAGE_VERSION = /^(\s*"version":\s*")([^"]+)(")/m;
const CARGO_WORKSPACE_VERSION =
  /(\[workspace\.package\][^[]*?\nversion\s*=\s*")([^"]+)(")/;
const SITE_VERSION = /(export const APP_VERSION = "v)([^"]+)(")/;

/** The files that carry the version, as `readVersions` and `setVersions` take them. */
export const VERSION_FILES = {
  packageJson: "package.json",
  cargoToml: "Cargo.toml",
  cargoLock: "Cargo.lock",
  site: "website/src/lib/site.ts",
};

const replaceOrThrow = (text, pattern, version, what) => {
  if (!pattern.test(text)) {
    throw new Error(`No version found in ${what}`);
  }
  return text.replace(pattern, `$1${version}$3`);
};

// Cargo.lock lists the workspace's own crates without a `source`; every
// dependency from a registry or git has one. So the lock names the crates,
// and a new one under crates/ is checked without anyone listing it.
const isPackage = (block) => block.startsWith("[[package]]\n");
const isWorkspaceCrate = (block) =>
  isPackage(block) && !LOCK_SOURCE.test(block);
const workspaceBlocks = (cargoLock) =>
  cargoLock.split(LOCK_PACKAGE_SEPARATOR).filter(isWorkspaceCrate);

/** The workspace's own crates, by name, as Cargo.lock lists them. */
export const workspaceCrates = (cargoLock) =>
  workspaceBlocks(cargoLock).map((block) => block.match(LOCK_NAME)?.[1]);

const setLockVersion = (cargoLock, version) =>
  cargoLock
    .split(LOCK_PACKAGE_SEPARATOR)
    .map((block) =>
      isWorkspaceCrate(block)
        ? block.replace(LOCK_VERSION, `$1${version}$3`)
        : block
    )
    .join("\n");

/**
 * Every place the version lives, keyed by a name that points at the file.
 * Throws when one is missing, so a moved line can't pass as "in step".
 */
export const readVersions = ({ packageJson, cargoToml, cargoLock, site }) => {
  const crates = workspaceBlocks(cargoLock);
  const versions = {
    "package.json": packageJson.match(PACKAGE_VERSION)?.[2],
    "Cargo.toml": cargoToml.match(CARGO_WORKSPACE_VERSION)?.[2],
    ...Object.fromEntries(
      crates.map((block) => [
        `Cargo.lock (${block.match(LOCK_NAME)?.[1]})`,
        block.match(LOCK_VERSION)?.[2],
      ])
    ),
    "website/src/lib/site.ts": site.match(SITE_VERSION)?.[2],
  };
  const missing = Object.keys(versions).filter((file) => !versions[file]);
  if (crates.length === 0) {
    missing.push("Cargo.lock (no workspace crates)");
  }
  if (missing.length > 0) {
    throw new Error(`No version found in ${missing.join(", ")}`);
  }
  return versions;
};

/**
 * The same files with `version` set everywhere. Throws, before anything is
 * written, when a file has no version line.
 */
export const setVersions = (files, version) => {
  const updated = {
    packageJson: replaceOrThrow(
      files.packageJson,
      PACKAGE_VERSION,
      version,
      "package.json"
    ),
    cargoToml: replaceOrThrow(
      files.cargoToml,
      CARGO_WORKSPACE_VERSION,
      version,
      "Cargo.toml [workspace.package]"
    ),
    cargoLock: setLockVersion(files.cargoLock, version),
    site: replaceOrThrow(
      files.site,
      SITE_VERSION,
      version,
      "website/src/lib/site.ts APP_VERSION"
    ),
  };
  readVersions(updated);
  return updated;
};

const parseRelease = (version) => {
  const match = version.match(RELEASE);
  if (!match) {
    throw new Error(`"${version}" is not a release version (x.y.z)`);
  }
  return match.slice(1).map(Number);
};

/** True when release version `a` comes after `b`. Both must be x.y.z. */
export const isNewer = (a, b) => {
  parseRelease(a);
  parseRelease(b);
  return compareVersions(a, b) > 0;
};

/**
 * cliff.toml's `tag_pattern`, the one definition of a release tag. git-cliff
 * counts from the tags it matches, so the script must count from the same ones.
 */
export const readTagPattern = (cliffToml) => {
  const pattern = cliffToml.match(TAG_PATTERN)?.[1];
  if (!pattern) {
    throw new Error("No tag_pattern in cliff.toml");
  }
  return new RegExp(pattern.replace(TOML_ESCAPE, "$1"));
};

/** The highest release tag, without the v. */
export const latestRelease = (tags, tagPattern) =>
  tags
    .filter((tag) => tagPattern.test(tag))
    .map((tag) => tag.replace(LEADING_V, ""))
    .reduce(
      (latest, version) =>
        latest === undefined || isNewer(version, latest) ? version : latest,
      undefined
    );

/**
 * The next release: git-cliff's pick (`bumped`, as `--bumped-version` prints
 * it), or undefined when no commit since the latest release calls for one.
 * git-cliff then prints the latest release unchanged.
 */
export const nextRelease = (bumped, tags, tagPattern) => {
  const version = bumped.replace(LEADING_V, "");
  return version === latestRelease(tags, tagPattern) ? undefined : version;
};

/** The release a beta or nightly leads up to: the next release, else the next patch. */
export const preReleaseBase = (bumped, tags, tagPattern) => {
  const latest = latestRelease(tags, tagPattern);
  if (!latest) {
    throw new Error(
      "No release tag yet. Tag the last release first (see ADR 0045)"
    );
  }
  const next = nextRelease(bumped, tags, tagPattern);
  if (next) {
    return next;
  }
  const [major, minor, patch] = parseRelease(latest);
  return `${major}.${minor}.${patch + 1}`;
};

/** The next beta of `base`, one past the highest `v<base>-beta.N` tag. */
export const betaVersion = (base, tags) => {
  const prefix = `v${base}-beta.`;
  const highest = tags
    .filter((tag) => tag.startsWith(prefix))
    .map((tag) => Number(tag.slice(prefix.length)))
    .filter(Number.isInteger)
    .reduce((max, n) => Math.max(max, n), 0);
  return `${base}-beta.${highest + 1}`;
};

/**
 * `<base>-nightly.<YYYYMMDD>.<run>`, with the UTC date. The CI run number keeps
 * two nightlies on one day apart. Semver forbids leading zeros in a number.
 */
export const nightlyVersion = (base, date, run) => {
  if (!RUN_NUMBER.test(run)) {
    throw new Error(
      `A nightly needs a whole run number without leading zeros, got "${run}"`
    );
  }
  const day = date.toISOString().slice(0, 10).replaceAll("-", "");
  return `${base}-nightly.${day}.${run}`;
};

/** The channel a version (or its tag) ships on: stable, beta or nightly. */
export const channelOf = (version) => {
  const bare = version.replace(LEADING_V, "");
  if (RELEASE.test(bare)) {
    return "stable";
  }
  if (BETA.test(bare)) {
    return "beta";
  }
  if (NIGHTLY.test(bare)) {
    return "nightly";
  }
  throw new Error(`"${version}" is not a stable, beta or nightly version`);
};

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;
const NUMERIC = /^\d+$/;

const comparePart = (a, b) => {
  const [numA, numB] = [NUMERIC.test(a), NUMERIC.test(b)];
  if (numA && numB) {
    return Number(a) - Number(b);
  }
  if (numA !== numB) {
    return numA ? -1 : 1;
  }
  return a < b ? -1 : Number(a > b);
};

/**
 * Semver order, as the updater compares versions: negative when `a` comes
 * before `b`, 0 when equal, positive after. A release comes after its own
 * pre-releases; pre-release parts compare as numbers or text.
 */
export const compareVersions = (a, b) => {
  const parse = (version) => {
    const match = version.replace(LEADING_V, "").match(SEMVER);
    if (!match) {
      throw new Error(`"${version}" is not a version`);
    }
    return {
      core: match.slice(1, 4).map(Number),
      pre: match[4]?.split(".") ?? [],
    };
  };
  const [pa, pb] = [parse(a), parse(b)];
  const core = pa.core.map((n, i) => n - pb.core[i]).find((d) => d !== 0);
  if (core) {
    return core;
  }
  if (pa.pre.length === 0 || pb.pre.length === 0) {
    return pb.pre.length - pa.pre.length;
  }
  for (let i = 0; i < Math.min(pa.pre.length, pb.pre.length); i += 1) {
    const diff = comparePart(pa.pre[i], pb.pre[i]);
    if (diff !== 0) {
      return diff;
    }
  }
  return pa.pre.length - pb.pre.length;
};

/**
 * The tag a pre-release's notes count from: the newest release or pre-release
 * of the same channel before `version`, so each beta lists what is new since
 * the last beta, and each nightly since the last nightly. Undefined when
 * there is none. A release's notes are its CHANGELOG.md entry instead.
 * `tagPattern` is cliff.toml's, so a release counts exactly when git-cliff
 * counts it.
 */
export const notesSince = (version, tags, tagPattern) => {
  const sameLine = channelOf(version) === "beta" ? BETA : NIGHTLY;
  const counts = (tag) =>
    tagPattern.test(tag) || sameLine.test(tag.replace(LEADING_V, ""));
  return tags
    .filter(counts)
    .filter((tag) => compareVersions(tag, version) < 0)
    .reduce(
      (since, tag) =>
        since === undefined || compareVersions(tag, since) > 0 ? tag : since,
      undefined
    );
};

/** True when no version in `others` comes after `version`. */
export const isNewest = (version, others) =>
  others.every((other) => compareVersions(version, other) >= 0);

/** True when a version (or its tag) is a nightly. */
export const isNightly = (version) =>
  NIGHTLY.test(version.replace(LEADING_V, ""));

/**
 * Strips guidance comments, then refuses an entry whose heading isn't
 * `## <version> — <date>` (the shape cliff.toml writes) or that is empty below it.
 */
export const cleanEntry = (text, version) => {
  const entry = `${text.replace(COMMENT, "").replace(BLANK_RUN, "\n\n").trim()}\n`;
  const [heading, ...body] = entry.split("\n");
  if (!heading.startsWith(`## ${version} — `)) {
    throw new Error(
      `The changelog entry must start with "## ${version} — <date>"`
    );
  }
  if (!body.join("").trim()) {
    throw new Error("The changelog entry is empty under its heading");
  }
  return entry;
};

/**
 * A pre-release's notes: git-cliff's draft without its heading or guidance
 * comments. Empty when the draft lists nothing.
 */
export const draftNotes = (draft) => {
  const body = draft.replace(COMMENT, "").replace(HEADING_LINE, "").trim();
  return body ? `${body.replace(BLANK_RUN, "\n\n")}\n` : "";
};

/** True when a git-cliff draft lists any change, i.e. has a group heading. */
export const listsChanges = (draft) => CHANGE_GROUP.test(draft);

/**
 * The body of `version`'s entry in CHANGELOG.md, without its heading: the
 * release notes. Throws when there is no entry for it.
 */
export const changelogEntry = (changelog, version) => {
  const heading = `\n## ${version} — `;
  const start = changelog.indexOf(heading);
  if (start === -1) {
    throw new Error(`No ${version} entry in CHANGELOG.md`);
  }
  const body = changelog.slice(changelog.indexOf("\n", start + 1) + 1);
  const end = body.indexOf("\n## ");
  return `${(end === -1 ? body : body.slice(0, end)).trim()}\n`;
};

/** Puts `entry` above the newest entry, below the file's header. */
export const insertChangelogEntry = (changelog, entry) => {
  const first = changelog.indexOf("\n## ");
  if (first === -1) {
    return `${changelog.trimEnd()}\n\n${entry.trimEnd()}\n`;
  }
  return `${changelog.slice(0, first + 1)}${entry.trimEnd()}\n\n${changelog.slice(first + 1)}`;
};
