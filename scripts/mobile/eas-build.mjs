#!/usr/bin/env node
// EAS Build's hooks for the phone app (mobile/app/package.json runs them):
//
//   eas-build-pre-install   node ../../scripts/mobile/eas-build.mjs pre-install
//   eas-build-post-install  node ../../scripts/mobile/eas-build.mjs post-install
//
// Before install, the phone's Rust library is built for the build's platform
// (scripts/mobile/build-ios.sh or build-android.sh), so CocoaPods and Gradle
// find it: EAS's build servers have no Rust, so a minimal toolchain is
// installed first. The push sender's and relay's addresses
// (KRIYON_PUSH_URL, KRIYON_RELAY_API) come from the build's environment, set
// in the Expo project, never from the repo. After install, the terminal
// page the app carries is made. `steps` is the plan, pure, and tested
// (eas-build.test.mjs); running it is the rest of this file.

import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PLATFORMS = new Set(["android", "ios"]);

/** The Rust a store build is made with: the same each time. */
export const RUST_VERSION = "1.99.0";

/** React Native 0.88's NDK, which eas.json has EAS install. */
export const NDK_VERSION = "27.1.12297006";

// Rust's own installer, fetched first so a failed download stops the build:
// the pinned toolchain, no docs or extra components.
const RUSTUP = [
  'installer="$(mktemp)"',
  'curl --proto =https --tlsv1.2 -sSf https://sh.rustup.rs -o "$installer" && sh "$installer" -y --profile minimal --default-toolchain ' +
    RUST_VERSION,
].join(" && ");

/**
 * What to run in `phase` (`pre-install` or `post-install`) for EAS's `env`,
 * from the repo at `root`; `hasRustup` says whether Rust's installer is there already.
 * Each step is `{ command, args, env }`, `env` the whole environment for it.
 */
export function steps(phase, env, { hasRustup, root }) {
  const platform = env.EAS_BUILD_PLATFORM;
  if (!PLATFORMS.has(platform)) {
    throw new Error(`eas-build: no phone platform "${platform}"`);
  }
  if (phase === "post-install") {
    return [
      {
        args: [join(root, "mobile/app/scripts/terminal-page.mjs")],
        command: "node",
        env,
      },
    ];
  }
  if (phase !== "pre-install") {
    throw new Error(`eas-build: no phase "${phase}"`);
  }
  const plan = [];
  let buildEnv = { ...env };
  if (!hasRustup) {
    plan.push({ args: ["-c", RUSTUP], command: "sh", env });
    buildEnv = {
      ...buildEnv,
      PATH: [join(env.HOME, ".cargo/bin"), env.PATH].filter(Boolean).join(":"),
    };
  }
  // EAS installs the NDK eas.json names under the SDK. That one, not any
  // NDK the image points to, is the one React Native's build uses too.
  if (platform === "android") {
    const sdk = buildEnv.ANDROID_HOME ?? buildEnv.ANDROID_SDK_ROOT;
    if (sdk) {
      buildEnv = {
        ...buildEnv,
        ANDROID_HOME: sdk,
        ANDROID_NDK_HOME: join(sdk, "ndk", NDK_VERSION),
      };
    }
  }
  plan.push({
    // A store or shared build installs on phones only: no Simulator slice.
    args: platform === "ios" ? ["--device-only"] : [],
    command: join(root, `scripts/mobile/build-${platform}.sh`),
    env: buildEnv,
  });
  return plan;
}

function run({ command, args, env }) {
  const done = spawnSync(command, args, { env, stdio: "inherit" });
  if (done.status !== 0) {
    throw new Error(
      `eas-build: ${command} failed (${done.status ?? done.signal})`
    );
  }
}

const isMain =
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  // The build scripts add Rust targets with rustup: cargo alone isn't enough.
  const hasRustup =
    spawnSync("rustup", ["--version"], { stdio: "ignore" }).status === 0;
  try {
    for (const step of steps(process.argv[2], process.env, {
      hasRustup,
      root,
    })) {
      run(step);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
