#!/usr/bin/env node
// Publishing helpers for the release workflows (.github/workflows/release.yml
// and publish.yml). See ADR 0046 and docs/RELEASING.md.
//
//   node scripts/publish.mjs check-feed <darwin|windows|latest>.json --version <x.y.z…>
//       Check one platform's update feed before anyone can get it (ADR 0056):
//       that platform's entries are there and no other's, and each file
//       downloads and is signed by the key in src-tauri/tauri.updater.conf.json
//       for that version. The file's name says the platform; latest.json, the
//       feed builds up to 0.15.0 read, is the Mac's. Downloads use $GH_TOKEN
//       when set, so a draft release's files can be read.
//   node scripts/publish.mjs platform-assets <darwin|windows> <name>…
//       Print the release file names that platform's build uploads.
//   node scripts/publish.mjs platform-feed <latest.json> --platform <darwin|windows>
//       Print the feed with only that platform's entries.
//   node scripts/publish.mjs windows-feed --version <v> --url <setup.exe url>
//       --sig <setup.exe.sig> [--notes-file <file>]
//       Print the Windows feed for one NSIS setup.exe.
//   node scripts/publish.mjs check-key
//       Check the updater key parses, before a build spends macOS minutes.
//
//       Both key checks need $PUBLIC_REPO set to "true" or "false" (the
//       workflows look it up), and refuse the test key when it is "true".
//       Anything else fails, so a failed lookup never passes for private.
//   node scripts/publish.mjs channel <version>
//       Print stable, beta or nightly.
//   node scripts/publish.mjs moves-forward <version> [<other>…]
//       Print true when no other version comes after <version>, so a feed
//       or the latest stable release only ever moves forward.
//   node scripts/publish.mjs nightlies <tag>…
//       Print the nightly tags among them, newest version first.
//   node scripts/publish.mjs stale-nightlies [--keep N] <tag>…
//       Print the nightly tags past the newest N (default 7), oldest first.
//   node scripts/publish.mjs cask <version> <dmg> <url>
//       Print the Homebrew cask for a stable release's DMG.
//
// Progress goes to stderr; stdout carries only the answer.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  assetPlatform,
  feedPlatform,
  feedProblems,
  homebrewCask,
  keyProblem,
  nightliesNewestFirst,
  platformFeed,
  publicRepoFrom,
  staleNightlies,
  verifyUpdateSignature,
  windowsFeed,
} from "./publish-lib.mjs";
import { channelOf, isNewest } from "./release-lib.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const UPDATER_CONFIG = "src-tauri/tauri.updater.conf.json";
const KEEP_NIGHTLIES = 7;

const fail = (message) => {
  console.error(`\n✗ ${message}\n`);
  process.exit(1);
};
const ok = (message) => console.error(`  ✓ ${message}`);

const updaterKey = () => {
  const config = JSON.parse(
    readFileSync(join(repoRoot, UPDATER_CONFIG), "utf8")
  );
  const key = config.plugins?.updater?.pubkey;
  if (!key) {
    fail(`No plugins.updater.pubkey in ${UPDATER_CONFIG}`);
  }
  const problem = keyProblem(key, {
    publicRepo: publicRepoFrom(process.env.PUBLIC_REPO),
  });
  if (problem) {
    fail(problem);
  }
  return key;
};

const download = async (url) => {
  const headers = { Accept: "application/octet-stream" };
  if (process.env.GH_TOKEN) {
    headers.Authorization = `Bearer ${process.env.GH_TOKEN}`;
  }
  const response = await fetch(url, { headers });
  if (!response.ok) {
    throw new Error(
      `${url} answered ${response.status} ${response.statusText}`
    );
  }
  return Buffer.from(await response.arrayBuffer());
};

const checkFeed = async (feedFile, version) => {
  if (!(feedFile && version)) {
    fail("Usage: check-feed <darwin|windows|latest>.json --version <version>");
  }
  const platform = feedPlatform(feedFile);
  const feed = JSON.parse(readFileSync(resolve(feedFile), "utf8"));
  const problems = feedProblems(feed, version, platform);
  if (problems.length > 0) {
    fail(`The ${platform} feed isn't ready:\n  - ${problems.join("\n  - ")}`);
  }
  ok(`The ${platform} feed announces ${version}`);
  const publicKey = updaterKey();
  // A universal build lists one file under several names; fetch each once.
  const urls = [
    ...new Set(Object.values(feed.platforms).map(({ url }) => url)),
  ];
  const files = new Map(
    await Promise.all(urls.map(async (url) => [url, await download(url)]))
  );
  for (const [platform, { url, signature }] of Object.entries(feed.platforms)) {
    try {
      verifyUpdateSignature({
        data: files.get(url),
        signature,
        publicKey,
        version,
      });
    } catch (error) {
      fail(`${platform}: ${error.message}`);
    }
    ok(`${platform} downloads and is signed for ${version}`);
  }
};

const printPlatformAssets = ([platform, ...names]) => {
  if (!platform) {
    fail("Usage: platform-assets <darwin|windows> <name>…");
  }
  for (const name of names) {
    if (assetPlatform(name) === platform) {
      console.log(name);
    }
  }
};

const printPlatformFeed = (feedFile, platform) => {
  if (!(feedFile && platform)) {
    fail("Usage: platform-feed <latest.json> --platform <darwin|windows>");
  }
  const feed = JSON.parse(readFileSync(resolve(feedFile), "utf8"));
  console.log(JSON.stringify(platformFeed(feed, platform), null, 2));
};

const printWindowsFeed = (values) => {
  if (!(values.version && values.url && values.sig)) {
    fail(
      "Usage: windows-feed --version <v> --url <url> --sig <file> [--notes-file <file>]"
    );
  }
  const notesFile = values["notes-file"];
  const feed = windowsFeed({
    version: values.version,
    notes: notesFile ? readFileSync(notesFile, "utf8").trim() : "",
    pubDate: new Date().toISOString(),
    url: values.url,
    signature: readFileSync(values.sig, "utf8").trim(),
  });
  console.log(JSON.stringify(feed, null, 2));
};

const main = async () => {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      version: { type: "string" },
      keep: { type: "string", default: String(KEEP_NIGHTLIES) },
      platform: { type: "string" },
      url: { type: "string" },
      sig: { type: "string" },
      "notes-file": { type: "string" },
    },
  });
  const [command, ...args] = positionals;
  switch (command) {
    case "check-feed":
      await checkFeed(args[0], values.version);
      break;
    case "platform-assets":
      printPlatformAssets(args);
      break;
    case "platform-feed":
      printPlatformFeed(args[0], values.platform);
      break;
    case "windows-feed":
      printWindowsFeed(values);
      break;
    case "check-key":
      updaterKey();
      ok(`The updater key in ${UPDATER_CONFIG} can sign releases here`);
      break;
    case "channel":
      console.log(channelOf(args[0] ?? ""));
      break;
    case "moves-forward": {
      const [version, ...others] = args;
      if (!version) {
        fail("Usage: moves-forward <version> [<other>…]");
      }
      console.log(isNewest(version, others));
      break;
    }
    case "nightlies":
      for (const tag of nightliesNewestFirst(args)) {
        console.log(tag);
      }
      break;
    case "stale-nightlies": {
      const keep = Number(values.keep);
      // A bad --keep must not read as 0 and delete every nightly.
      if (!Number.isInteger(keep) || keep < 1) {
        fail(`--keep must be a whole number above 0, got "${values.keep}"`);
      }
      for (const tag of staleNightlies(args, keep)) {
        console.log(tag);
      }
      break;
    }
    case "cask": {
      const [version, dmg, url] = args;
      if (!(version && dmg && url)) {
        fail("Usage: cask <version> <dmg> <url>");
      }
      const sha256 = createHash("sha256")
        .update(readFileSync(dmg))
        .digest("hex");
      process.stdout.write(homebrewCask({ version, sha256, url }));
      break;
    }
    default:
      fail(
        `Unknown command "${command ?? ""}". See the header of scripts/publish.mjs.`
      );
  }
};

try {
  await main();
} catch (error) {
  fail(error.message);
}
