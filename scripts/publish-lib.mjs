// Pure helpers for scripts/publish.mjs: the update feed check, the update
// key and repo visibility, which nightlies to delete and the Homebrew cask.
// Version shapes and channels live in release-lib.mjs, beside the code that
// writes them. No IO here, so they're tested directly (scripts/publish.test.mjs).
//
// The feed check mirrors what the Tauri updater does on a user's machine, so
// a feed that passes here is one the app accepts. Signatures are minisign's format, which `tauri signer` writes: the key and
// each signature are a small text file, base64-encoded once more as a whole.

import { createHash, createPublicKey, verify } from "node:crypto";
import { channelOf, compareVersions, isNightly } from "./release-lib.mjs";

/** The feed entries a universal Mac build must have: one per chip. */
const MAC_PLATFORMS = ["darwin-aarch64", "darwin-x86_64"];

const LEADING_V = /^v/;
const SHA256 = /^[0-9a-f]{64}$/;
const TRUSTED_PREFIX = "trusted comment: ";
const PUBLIC_KEY_BYTES = 42;
const SIGNATURE_BYTES = 74;
const GLOBAL_SIGNATURE_BYTES = 64;

const lines = (base64) =>
  Buffer.from(base64, "base64").toString("utf8").split("\n");

// Key ids as minisign and `tauri signer` print them: the bytes reversed.
const hex = (bytes) =>
  Buffer.from(bytes).reverse().toString("hex").toUpperCase();

/**
 * The throwaway key the private repo tests the pipeline with. Its private
 * half was never guarded, so a public release must not trust it: Phase 8
 * swaps in the real key (docs/RELEASING.md).
 */
const TEST_KEY_ID = "BD4E5D6CC630A741";

const parsePublicKey = (publicKey) => {
  const bytes = Buffer.from(lines(publicKey)[1] ?? "", "base64");
  if (
    bytes.length !== PUBLIC_KEY_BYTES ||
    bytes.subarray(0, 2).toString() !== "Ed"
  ) {
    throw new Error("The updater key is not a minisign public key");
  }
  const raw = bytes.subarray(10);
  return {
    keyId: hex(bytes.subarray(2, 10)),
    key: createPublicKey({
      key: { kty: "OKP", crv: "Ed25519", x: raw.toString("base64url") },
      format: "jwk",
    }),
  };
};

const parseSignature = (signature) => {
  const [, box, trusted = "", global = ""] = lines(signature);
  const bytes = Buffer.from(box ?? "", "base64");
  const algorithm = bytes.subarray(0, 2).toString();
  const globalBytes = Buffer.from(global, "base64");
  if (
    bytes.length !== SIGNATURE_BYTES ||
    !["Ed", "ED"].includes(algorithm) ||
    !trusted.startsWith(TRUSTED_PREFIX) ||
    globalBytes.length !== GLOBAL_SIGNATURE_BYTES
  ) {
    throw new Error("The signature is not a minisign signature");
  }
  return {
    prehashed: algorithm === "ED",
    keyId: hex(bytes.subarray(2, 10)),
    signature: bytes.subarray(10),
    trustedComment: trusted.slice(TRUSTED_PREFIX.length),
    globalSignature: globalBytes,
  };
};

// The Tauri CLI writes `timestamp:…\tfile:…\tversion:…`.
const signedVersion = (trustedComment) =>
  trustedComment
    .split("\t")
    .find((field) => field.startsWith("version:"))
    ?.slice("version:".length);

const sameVersion = (a, b) =>
  a.replace(LEADING_V, "") === b.replace(LEADING_V, "");

/**
 * Throws unless `data` is signed by `publicKey` (as tauri.conf.json holds it)
 * for `version`, the version the feed announces. Checks what the updater
 * checks with `requireSignedVersion` on: the signature, the trusted comment
 * under minisign's global signature, and the version recorded in it.
 */
export const verifyUpdateSignature = ({
  data,
  signature,
  publicKey,
  version,
}) => {
  const trusted = parsePublicKey(publicKey);
  const parsed = parseSignature(signature);
  if (parsed.keyId !== trusted.keyId) {
    throw new Error(
      `The file is signed with key ${parsed.keyId}, but the app trusts ${trusted.keyId}`
    );
  }
  const message = parsed.prehashed
    ? createHash("blake2b512").update(data).digest()
    : data;
  if (!verify(null, message, trusted.key, parsed.signature)) {
    throw new Error("The signature doesn't match the file");
  }
  const covered = Buffer.concat([
    parsed.signature,
    Buffer.from(parsed.trustedComment),
  ]);
  if (!verify(null, covered, trusted.key, parsed.globalSignature)) {
    throw new Error("The trusted comment isn't covered by the signature");
  }
  const signed = signedVersion(parsed.trustedComment);
  if (!signed) {
    throw new Error(
      "The signature doesn't say which version it was signed for"
    );
  }
  if (!sameVersion(signed, version)) {
    throw new Error(
      `The file was signed for version ${signed}, but the feed announces ${version}`
    );
  }
};

/**
 * Why `publicKey` (as tauri.conf.json holds it) can't sign releases here, or
 * undefined when it can: it must parse, and a public repo must not use the
 * test key.
 */
export const keyProblem = (publicKey, { publicRepo }) => {
  let keyId;
  try {
    ({ keyId } = parsePublicKey(publicKey));
  } catch (error) {
    return error.message;
  }
  if (publicRepo && keyId === TEST_KEY_ID) {
    return `The updater key is the test key ${TEST_KEY_ID}. Make the real key before releasing from a public repo (docs/RELEASING.md).`;
  }
};

/**
 * What's wrong with a parsed latest.json for `version`, as plain sentences;
 * empty when nothing is. The updater rejects the whole file when any entry is
 * incomplete, so every entry is checked, not only the Mac ones.
 */
export const feedProblems = (feed, version) => {
  const problems = [];
  if (
    typeof feed?.version !== "string" ||
    !sameVersion(feed.version, version)
  ) {
    problems.push(`The feed announces "${feed?.version}", not ${version}`);
  }
  const platforms = feed?.platforms;
  if (typeof platforms !== "object" || platforms === null) {
    problems.push("The feed has no platforms");
    return problems;
  }
  for (const name of MAC_PLATFORMS) {
    if (!(name in platforms)) {
      problems.push(`${name} is missing`);
    }
  }
  for (const [name, entry] of Object.entries(platforms)) {
    for (const field of ["url", "signature"]) {
      if (typeof entry?.[field] !== "string" || !entry[field]) {
        problems.push(`${name} has no ${field}`);
      }
    }
  }
  return problems;
};

/**
 * The nightly tags among `tags`, newest first in version order, the order
 * the nightly feed moves in and the updater installs in. So the release the
 * feed names is always among the newest.
 */
export const nightliesNewestFirst = (tags) =>
  tags.filter(isNightly).sort((a, b) => compareVersions(b, a));

/** The nightly tags to delete so only the newest `keep` remain, oldest first. */
export const staleNightlies = (tags, keep) =>
  nightliesNewestFirst(tags).slice(keep).reverse();

/**
 * Whether the repo is public, from the workflows' lookup ("true"/"false").
 * Anything else throws: a failed lookup must not pass for a private repo,
 * where the test key is allowed.
 */
export const publicRepoFrom = (value) => {
  if (value === "true" || value === "false") {
    return value === "true";
  }
  throw new Error(
    `Can't tell whether the repo is public: PUBLIC_REPO is "${value ?? ""}", not true or false`
  );
};

/** The tap's Casks/kriyon.rb for a stable release's DMG. */
export const homebrewCask = ({ version, sha256, url }) => {
  if (channelOf(version) !== "stable") {
    throw new Error(`The tap carries only stable releases, not ${version}`);
  }
  if (!SHA256.test(sha256)) {
    throw new Error(`"${sha256}" is not a SHA-256 checksum`);
  }
  return `# Written by the Kriyon release workflow (scripts/publish.mjs); edits here are replaced.
cask "kriyon" do
  version "${version}"
  sha256 "${sha256}"

  url "${url}",
      verified: "github.com/LeafyCode/kriyon/"
  name "Kriyon"
  desc "Desktop app for the Claude Code CLI, with a Changes view beside it"
  homepage "https://kriyon.app/"

  livecheck do
    url :url
    strategy :github_latest
  end

  depends_on macos: ">= :catalina"

  app "Kriyon.app"

  zap trash: [
    "~/Library/Application Support/com.leafycode.kriyon",
    "~/Library/Caches/com.leafycode.kriyon",
    "~/Library/Preferences/com.leafycode.kriyon.plist",
    "~/Library/Saved Application State/com.leafycode.kriyon.savedState",
    "~/Library/WebKit/com.leafycode.kriyon",
  ]
end
`;
};
