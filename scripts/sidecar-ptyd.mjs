#!/usr/bin/env node
// Build kriyon-ptyd and stage it as a Tauri sidecar (externalBin).
//
// Tauri's `bundle.externalBin` resolves each entry to a `<name>-<target-triple>`
// artifact under src-tauri/binaries, then copies it next to the app executable
// (stripping the suffix). The app finds it there at runtime via current_exe()'s
// sibling. We build the daemon and stage it at the suffixed path the bundler
// expects.
//
// Target selection (highest priority first):
//   1. `--target <triple>` argument
//   2. KRIYON_SIDECAR_TARGET env var (set by scripts/release-mac.sh)
//   3. the host triple (default for `tauri dev` and plain host builds)
//
// The synthetic triple `universal-apple-darwin` builds both macOS arches. Tauri
// bundles a universal app in two stages, and each resolves the sidecar by a
// different suffix: the two per-arch sub-builds want `-x86_64-apple-darwin` and
// `-aarch64-apple-darwin`, and the final bundle-copy (after it lipos the app)
// wants `-universal-apple-darwin`. So we `lipo` the two arches into one fat
// Mach-O and stage it under ALL THREE names, giving every stage a binary that
// runs on Apple Silicon and Intel alike.
//
// Pass --release to build the optimized profile (used by `tauri build`); omit it
// for the debug profile (used by `tauri dev`). The release profile uses thin LTO
// (see Cargo.toml [profile.release]); on a low-memory machine set CARGO_BUILD_JOBS
// (e.g. =2) to cap parallelism — cargo honors it here natively. release-mac.sh
// exports it from KRIYON_CARGO_JOBS.

import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const UNIVERSAL = "universal-apple-darwin";
const UNIVERSAL_MEMBERS = ["aarch64-apple-darwin", "x86_64-apple-darwin"];

const args = process.argv.slice(2);
const release = args.includes("--release");
const profile = release ? "release" : "debug";
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function hostTriple() {
  const triple = execFileSync("rustc", ["--print", "host-tuple"], {
    encoding: "utf8",
  }).trim();
  if (!triple) {
    throw new Error("could not determine the host target triple from rustc");
  }
  return triple;
}

function requestedTarget() {
  const flagIndex = args.indexOf("--target");
  if (flagIndex !== -1) {
    const value = args[flagIndex + 1];
    if (!value) {
      throw new Error("--target requires a target-triple argument");
    }
    return value;
  }
  return process.env.KRIYON_SIDECAR_TARGET || hostTriple();
}

// Compile kriyon-ptyd for one concrete (non-universal) triple; return the path
// to the built binary. A `--target` flag nests the artifact under
// target/<triple>/; omitting it for the host keeps the plain target/<profile>/
// layout (and avoids forcing the host arch to be an explicit rustup target).
function buildFor(triple, host) {
  const cargoArgs = ["build", "-p", "kriyon-ptyd"];
  if (release) {
    cargoArgs.push("--release");
  }
  let builtDir = join(repoRoot, "target", profile);
  if (triple !== host) {
    cargoArgs.push("--target", triple);
    builtDir = join(repoRoot, "target", triple, profile);
  }
  execFileSync("cargo", cargoArgs, { stdio: "inherit" });
  return join(builtDir, "kriyon-ptyd");
}

const sidecarDir = join(repoRoot, "src-tauri", "binaries");
mkdirSync(sidecarDir, { recursive: true });

const target = requestedTarget();

if (target === UNIVERSAL) {
  const host = hostTriple();
  const members = UNIVERSAL_MEMBERS.map((triple) => buildFor(triple, host));
  // Fuse the per-arch binaries into one fat Mach-O, then stage it under every
  // name Tauri looks for: each per-arch sub-build plus the final universal copy.
  const names = [...UNIVERSAL_MEMBERS, UNIVERSAL].map((triple) =>
    join(sidecarDir, `kriyon-ptyd-${triple}`)
  );
  const [primary, ...rest] = names;
  execFileSync("lipo", ["-create", "-output", primary, ...members], {
    stdio: "inherit",
  });
  for (const path of rest) {
    copyFileSync(primary, path);
  }
  console.log(`staged universal sidecar: ${names.join(", ")}`);
} else {
  const staged = join(sidecarDir, `kriyon-ptyd-${target}`);
  copyFileSync(buildFor(target, hostTriple()), staged);
  console.log(`staged sidecar: ${staged}`);
}
