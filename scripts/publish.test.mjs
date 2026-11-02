// Tests for the publishing helpers (scripts/publish-lib.mjs): the update feed
// check, the channel a version belongs to, which nightlies to delete, and the
// Homebrew cask. Keys and signatures are made here in minisign's format, the
// one `tauri signer` writes.
// Run: pnpm test:node
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { describe, test } from "node:test";
import {
  assetPlatform,
  feedPlatform,
  feedProblems,
  homebrewCask,
  keyProblem,
  nightliesNewestFirst,
  PLATFORMS,
  platformFeed,
  publicRepoFrom,
  staleNightlies,
  verifyUpdateSignature,
  windowsFeed,
  windowsInstaller,
} from "./publish-lib.mjs";

const NO_INSTALLER = /no Windows installer/;
const TWO_INSTALLERS = /more than one Windows installer/;
const MENTIONS_MISMATCH = /signature doesn't match the file/;
const MENTIONS_LINUX = /linux/;
const MENTIONS_LINUX_FILE = /linux\.json/;
const MENTIONS_BOTH_KEYS =
  /signed with key 0202020202020202, but the app trusts 0101010101010101/;
const MENTIONS_TRUSTED_COMMENT =
  /trusted comment isn't covered by the signature/;
const MENTIONS_SIGNED_VERSION =
  /signed for version 0\.13\.0, but the feed announces 0\.14\.0/;
const MENTIONS_NO_VERSION = /doesn't say which version it was signed for/;
const MENTIONS_BAD_SIGNATURE = /not a minisign signature/;
const MENTIONS_TEST_KEY = /test key BD4E5D6CC630A741/;
const MENTIONS_BAD_KEY = /not a minisign public key/;
const MENTIONS_VISIBILITY = /Can't tell whether the repo is public/;
const CASK_LINE = /^cask "kriyon" do$/m;
const VERSION_LINE = /^ {2}version "0\.13\.0"$/m;
const URL_LINE =
  /^ {2}url "https:\/\/github\.com\/LeafyCode\/kriyon\/releases\/download\/v0\.13\.0\/Kriyon_0\.13\.0_universal\.dmg",$/m;
const APP_LINE = /^ {2}app "Kriyon\.app"$/m;
const MENTIONS_SHA256 = /SHA-256/;
const MENTIONS_ONLY_STABLE = /only stable/;
const SHA256_LINE = new RegExp(`^ {2}sha256 "${"a".repeat(64)}"$`, "m");

const b64 = (bytes) => Buffer.from(bytes).toString("base64");

const makeKey = (keyIdByte = 1) => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const raw = Buffer.from(publicKey.export({ format: "jwk" }).x, "base64url");
  const keyId = Buffer.alloc(8, keyIdByte);
  const box = `untrusted comment: minisign public key: ${keyId.toString("hex")}\n${b64(
    Buffer.concat([Buffer.from("Ed"), keyId, raw])
  )}\n`;
  // tauri.conf.json holds the whole key file, base64-encoded.
  return { privateKey, keyId, publicKey: b64(box) };
};

// What `tauri signer sign` writes into a .sig file and latest.json carries.
const signFile = (
  data,
  { privateKey, keyId },
  {
    comment = "timestamp:1700000000\tfile:Kriyon.app.tar.gz\tversion:0.13.0",
    legacy = false,
  } = {}
) => {
  const message = legacy
    ? data
    : createHash("blake2b512").update(data).digest();
  const signature = sign(null, message, privateKey);
  const global = sign(
    null,
    Buffer.concat([signature, Buffer.from(comment)]),
    privateKey
  );
  const box = [
    "untrusted comment: signature from tauri secret key",
    b64(Buffer.concat([Buffer.from(legacy ? "Ed" : "ED"), keyId, signature])),
    `trusted comment: ${comment}`,
    b64(global),
    "",
  ].join("\n");
  return b64(box);
};

const data = Buffer.from("the update bundle");

describe("update signatures", () => {
  const key = makeKey();

  test("a file signed by the key for the announced version passes", () => {
    verifyUpdateSignature({
      data,
      signature: signFile(data, key),
      publicKey: key.publicKey,
      version: "0.13.0",
    });
  });

  test("a legacy (not prehashed) signature passes, as the updater allows", () => {
    verifyUpdateSignature({
      data,
      signature: signFile(data, key, { legacy: true }),
      publicKey: key.publicKey,
      version: "0.13.0",
    });
  });

  test("a changed file fails", () => {
    assert.throws(
      () =>
        verifyUpdateSignature({
          data: Buffer.from("something else"),
          signature: signFile(data, key),
          publicKey: key.publicKey,
          version: "0.13.0",
        }),
      MENTIONS_MISMATCH
    );
  });

  test("a file signed by another key fails and names both keys", () => {
    const other = makeKey(2);
    assert.throws(
      () =>
        verifyUpdateSignature({
          data,
          signature: signFile(data, other),
          publicKey: key.publicKey,
          version: "0.13.0",
        }),
      MENTIONS_BOTH_KEYS
    );
  });

  test("an edited trusted comment fails, since it carries the version", () => {
    const signature = Buffer.from(signFile(data, key), "base64")
      .toString("utf8")
      .replace("version:0.13.0", "version:0.14.0");
    assert.throws(
      () =>
        verifyUpdateSignature({
          data,
          signature: b64(signature),
          publicKey: key.publicKey,
          version: "0.14.0",
        }),
      MENTIONS_TRUSTED_COMMENT
    );
  });

  test("a file signed for another version fails", () => {
    assert.throws(
      () =>
        verifyUpdateSignature({
          data,
          signature: signFile(data, key),
          publicKey: key.publicKey,
          version: "0.14.0",
        }),
      MENTIONS_SIGNED_VERSION
    );
  });

  test("a signature without a version fails", () => {
    assert.throws(
      () =>
        verifyUpdateSignature({
          data,
          signature: signFile(data, key, {
            comment: "timestamp:1700000000\tfile:Kriyon.app.tar.gz",
          }),
          publicKey: key.publicKey,
          version: "0.13.0",
        }),
      MENTIONS_NO_VERSION
    );
  });

  test("a malformed signature is an error, not a pass", () => {
    assert.throws(
      () =>
        verifyUpdateSignature({
          data,
          signature: b64("not a signature"),
          publicKey: key.publicKey,
          version: "0.13.0",
        }),
      MENTIONS_BAD_SIGNATURE
    );
  });

  test("a malformed public key is an error", () => {
    assert.throws(
      () =>
        verifyUpdateSignature({
          data,
          signature: signFile(data, key),
          publicKey: b64("untrusted comment: x\nAAAA\n"),
          version: "0.13.0",
        }),
      MENTIONS_BAD_KEY
    );
  });
});

describe("the repo's visibility", () => {
  test("is read only from an explicit true or false", () => {
    assert.equal(publicRepoFrom("true"), true);
    assert.equal(publicRepoFrom("false"), false);
  });

  test("anything else is an error, so a failed lookup never reads as private", () => {
    for (const value of [undefined, "", "TRUE", "null"]) {
      assert.throws(() => publicRepoFrom(value), MENTIONS_VISIBILITY);
    }
  });
});

describe("the test update key", () => {
  // The throwaway key the private repo tests with (docs/RELEASING.md).
  const testKey =
    "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IEJENEU1RDZDQzYzMEE3NDEKUldSQnB6REdiRjFPdlViUlFnVE4xeU1GMWV2U0Y0S1dSbnJyRGdXdnByMXlDbDlUbXg0RDMrWkEK";

  test("is fine while the repo is private", () => {
    assert.equal(keyProblem(testKey, { publicRepo: false }), undefined);
  });

  test("is refused once the repo is public, named as minisign names it", () => {
    assert.match(keyProblem(testKey, { publicRepo: true }), MENTIONS_TEST_KEY);
  });

  test("any other key is fine in a public repo", () => {
    assert.equal(
      keyProblem(makeKey().publicKey, { publicRepo: true }),
      undefined
    );
  });

  test("a malformed key is a problem either way", () => {
    assert.match(
      keyProblem(b64("untrusted comment: x\nAAAA\n"), { publicRepo: false }),
      MENTIONS_BAD_KEY
    );
  });
});

describe("the feed file", () => {
  const entry = {
    signature: "c2ln",
    url: "https://example.com/Kriyon.app.tar.gz",
  };
  const mac = {
    version: "0.13.0",
    notes: "",
    pub_date: "2026-10-16T00:00:00Z",
    platforms: { "darwin-aarch64": entry, "darwin-x86_64": entry },
  };
  const windows = {
    ...mac,
    platforms: { "windows-x86_64": entry, "windows-x86_64-nsis": entry },
  };

  test("a Mac feed needs both chips' entries", () => {
    for (const missing of ["darwin-aarch64", "darwin-x86_64"]) {
      const { [missing]: _, ...rest } = mac.platforms;
      assert.deepEqual(
        feedProblems({ ...mac, platforms: rest }, "0.13.0", "darwin"),
        [`${missing} is missing`]
      );
    }
  });

  test("a Windows feed needs the x64 entry", () => {
    const { "windows-x86_64": _, ...rest } = windows.platforms;
    assert.deepEqual(
      feedProblems({ ...windows, platforms: rest }, "0.13.0", "windows"),
      ["windows-x86_64 is missing"]
    );
  });

  test("a complete feed for the expected version has no problems", () => {
    assert.deepEqual(feedProblems(mac, "0.13.0", "darwin"), []);
    assert.deepEqual(feedProblems(windows, "0.13.0", "windows"), []);
  });

  test("a platform's feed holds only that platform, so it can move on its own", () => {
    assert.deepEqual(
      feedProblems(
        { ...mac, platforms: { ...mac.platforms, "windows-x86_64": entry } },
        "0.13.0",
        "darwin"
      ),
      ["windows-x86_64 belongs in another platform's feed"]
    );
  });

  test("a platform the release doesn't know is refused", () => {
    assert.throws(() => feedProblems(mac, "0.13.0", "linux"), MENTIONS_LINUX);
  });

  test("a leading v on the feed's version is accepted, as the updater does", () => {
    assert.deepEqual(
      feedProblems({ ...mac, version: "v0.13.0" }, "0.13.0", "darwin"),
      []
    );
  });

  test("another version is a problem", () => {
    assert.deepEqual(feedProblems(mac, "0.13.1", "darwin"), [
      'The feed announces "0.13.0", not 0.13.1',
    ]);
  });

  test("an entry without a url or signature is a problem", () => {
    assert.deepEqual(
      feedProblems(
        {
          ...mac,
          platforms: { ...mac.platforms, "darwin-aarch64": { url: entry.url } },
        },
        "0.13.0",
        "darwin"
      ),
      ["darwin-aarch64 has no signature"]
    );
  });

  test("every entry must be complete, since the updater rejects the whole file otherwise", () => {
    assert.deepEqual(
      feedProblems(
        {
          ...mac,
          platforms: {
            ...mac.platforms,
            "darwin-aarch64-app": { signature: "c2ln" },
          },
        },
        "0.13.0",
        "darwin"
      ),
      ["darwin-aarch64-app has no url"]
    );
  });

  test("a feed that isn't an object with platforms is a problem", () => {
    assert.deepEqual(feedProblems({ version: "0.13.0" }, "0.13.0", "darwin"), [
      "The feed has no platforms",
    ]);
  });

  test("a feed file's name says its platform; latest.json is the Mac's, as old builds read it", () => {
    assert.equal(feedPlatform("darwin.json"), "darwin");
    assert.equal(feedPlatform("/tmp/x/windows.json"), "windows");
    assert.equal(feedPlatform("latest.json"), "darwin");
    assert.throws(() => feedPlatform("linux.json"), MENTIONS_LINUX_FILE);
  });

  test("each release file belongs to the platform that built it", () => {
    const darwin = [
      "darwin.json",
      "latest.json",
      "Kriyon.dmg",
      "Kriyon_0.16.0_universal.dmg",
      "Kriyon_universal.app.tar.gz",
      "Kriyon_universal.app.tar.gz.sig",
    ];
    const windows = [
      "windows.json",
      "Kriyon_0.16.0_x64-setup.exe",
      "Kriyon_0.16.0_x64-setup.exe.sig",
    ];
    for (const name of darwin) {
      assert.equal(assetPlatform(name), "darwin", name);
    }
    for (const name of windows) {
      assert.equal(assetPlatform(name), "windows", name);
    }
    assert.equal(assetPlatform("notes.txt"), undefined);
  });

  test("the platforms Kriyon releases for are the feed files' names", () => {
    assert.deepEqual(PLATFORMS, ["darwin", "windows"]);
    for (const platform of PLATFORMS) {
      assert.equal(feedPlatform(`${platform}.json`), platform);
    }
  });

  test("the Windows installer is the one setup.exe among the files, by any path", () => {
    assert.equal(
      windowsInstaller([
        "Kriyon_0.16.0_x64-setup.exe.sig",
        "dist/nsis/Kriyon_0.16.0_x64-setup.exe",
        "windows.json",
      ]),
      "dist/nsis/Kriyon_0.16.0_x64-setup.exe"
    );
    assert.equal(assetPlatform("Kriyon_0.16.0_x64-setup.exe"), "windows");
    assert.throws(() => windowsInstaller(["Kriyon.dmg"]), NO_INSTALLER);
    assert.throws(
      () =>
        windowsInstaller([
          "Kriyon_0.16.0_x64-setup.exe",
          "Kriyon_0.16.0_arm64-setup.exe",
        ]),
      TWO_INSTALLERS
    );
  });

  test("a platform's feed keeps only that platform's entries", () => {
    const both = {
      ...mac,
      platforms: { ...mac.platforms, ...windows.platforms },
    };
    assert.deepEqual(platformFeed(both, "darwin"), mac);
    assert.deepEqual(platformFeed(both, "windows"), windows);
  });

  test("a Mac-only feed gives Windows a file with no entries, read as no update", () => {
    assert.deepEqual(platformFeed(mac, "windows"), { ...mac, platforms: {} });
  });

  test("the Windows feed lists the setup.exe under both names the updater looks for", () => {
    assert.deepEqual(
      windowsFeed({
        version: "0.13.0",
        notes: "",
        pubDate: "2026-10-16T00:00:00Z",
        url: entry.url,
        signature: entry.signature,
      }),
      windows
    );
  });
});

describe("pruning nightlies", () => {
  const tags = [
    "v0.13.0-nightly.20261010.1",
    "v0.13.0-nightly.20261012.3",
    "v0.13.0-nightly.20261011.2",
    "v0.13.1-nightly.20261014.5",
    "v0.13.0-nightly.20261013.4",
    "v0.13.0-beta.1",
    "v0.12.0",
    "feed-nightly",
  ];

  test("only nightlies past the newest few go, oldest first", () => {
    assert.deepEqual(staleNightlies(tags, 3), [
      "v0.13.0-nightly.20261010.1",
      "v0.13.0-nightly.20261011.2",
    ]);
  });

  test("newest is by version, as the feed and the updater order them", () => {
    // A later build with a lower base never displaces the one the feed names.
    assert.deepEqual(
      staleNightlies(
        ["v0.14.0-nightly.20261001.9", "v0.13.1-nightly.20261002.10"],
        1
      ),
      ["v0.13.1-nightly.20261002.10"]
    );
  });

  test("two nightlies on one day are ordered by run number", () => {
    assert.deepEqual(
      staleNightlies(
        ["v0.13.0-nightly.20261016.10", "v0.13.0-nightly.20261016.9"],
        1
      ),
      ["v0.13.0-nightly.20261016.9"]
    );
  });

  test("the nightlies among other tags, newest first", () => {
    assert.deepEqual(nightliesNewestFirst(tags).slice(0, 2), [
      "v0.13.1-nightly.20261014.5",
      "v0.13.0-nightly.20261013.4",
    ]);
    assert.deepEqual(nightliesNewestFirst(["v0.13.0", "feed-nightly"]), []);
  });

  test("with no more than the newest few, nothing goes", () => {
    assert.deepEqual(staleNightlies(tags, 7), []);
  });
});

describe("the Homebrew cask", () => {
  const cask = homebrewCask({
    version: "0.13.0",
    sha256: "a".repeat(64),
    url: "https://github.com/LeafyCode/kriyon/releases/download/v0.13.0/Kriyon_0.13.0_universal.dmg",
  });

  test("names the version, the checksum and the download", () => {
    assert.match(cask, CASK_LINE);
    assert.match(cask, VERSION_LINE);
    assert.match(cask, SHA256_LINE);
    assert.match(cask, URL_LINE);
    assert.match(cask, APP_LINE);
  });

  test("refuses a checksum that isn't SHA-256", () => {
    assert.throws(
      () =>
        homebrewCask({ version: "0.13.0", sha256: "abc", url: "https://x" }),
      MENTIONS_SHA256
    );
  });

  test("refuses a pre-release, since the tap carries only stable", () => {
    assert.throws(
      () =>
        homebrewCask({
          version: "0.13.0-beta.1",
          sha256: "a".repeat(64),
          url: "https://x",
        }),
      MENTIONS_ONLY_STABLE
    );
  });
});
