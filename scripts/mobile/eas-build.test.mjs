import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { NDK_VERSION, RUST_VERSION, steps } from "./eas-build.mjs";

const ROOT = "/build/repo";
const HOME = "/home/expo";

const RUSTUP_SITE = /sh\.rustup\.rs/;
const MINIMAL = /--profile minimal/;
const AND_THEN = /-o "\$installer" && sh "\$installer"/;
const PLATFORM = /platform/;
const PHASE = /phase/;

const commands = (list) =>
  list.map((step) => [step.command, ...step.args].join(" "));

test("before install, the Rust library is built for the build's platform", () => {
  const ios = steps(
    "pre-install",
    { EAS_BUILD_PLATFORM: "ios", HOME },
    {
      hasRustup: true,
      root: ROOT,
    }
  );
  // A store or shared build installs on phones only: no Simulator slice.
  assert.deepEqual(commands(ios), [
    `${ROOT}/scripts/mobile/build-ios.sh --device-only`,
  ]);
  const android = steps(
    "pre-install",
    { EAS_BUILD_PLATFORM: "android", HOME },
    {
      hasRustup: true,
      root: ROOT,
    }
  );
  assert.deepEqual(commands(android), [
    `${ROOT}/scripts/mobile/build-android.sh`,
  ]);
});

test("a build server without Rust gets it first, and the build finds it", () => {
  const plan = steps(
    "pre-install",
    { EAS_BUILD_PLATFORM: "android", HOME, PATH: "/usr/bin" },
    {
      hasRustup: false,
      root: ROOT,
    }
  );
  assert.equal(plan.length, 2);
  assert.match(commands(plan)[0], RUSTUP_SITE);
  assert.match(commands(plan)[0], MINIMAL);
  // The same Rust each time, and a failed download stops the build.
  assert.match(
    commands(plan)[0],
    new RegExp(`--default-toolchain ${RUST_VERSION}`)
  );
  assert.match(commands(plan)[0], AND_THEN);
  assert.equal(plan[1].env.PATH, `${HOME}/.cargo/bin:/usr/bin`);
});

test("the Android build finds the NDK EAS installed under the SDK", () => {
  const [build] = steps(
    "pre-install",
    { ANDROID_SDK_ROOT: "/opt/android", EAS_BUILD_PLATFORM: "android", HOME },
    { hasRustup: true, root: ROOT }
  );
  assert.equal(build.env.ANDROID_HOME, "/opt/android");
  assert.equal(build.env.ANDROID_NDK_HOME, `/opt/android/ndk/${NDK_VERSION}`);
});

test("an NDK the image set itself is not the one used", () => {
  const [build] = steps(
    "pre-install",
    {
      ANDROID_HOME: "/opt/android",
      ANDROID_NDK_HOME: "/opt/android/ndk/26.0.0",
      EAS_BUILD_PLATFORM: "android",
      HOME,
    },
    { hasRustup: true, root: ROOT }
  );
  assert.equal(build.env.ANDROID_NDK_HOME, `/opt/android/ndk/${NDK_VERSION}`);
});

test("the NDK is the one eas.json has EAS install", () => {
  const eas = JSON.parse(
    readFileSync(new URL("../../mobile/app/eas.json", import.meta.url), "utf8")
  );
  assert.equal(eas.build.base.android.ndk, NDK_VERSION);
});

test("the push and relay addresses come from the build's own settings, as given", () => {
  const [build] = steps(
    "pre-install",
    {
      EAS_BUILD_PLATFORM: "ios",
      HOME,
      KRIYON_PUSH_URL: "https://push.example",
    },
    { hasRustup: true, root: ROOT }
  );
  assert.equal(build.env.KRIYON_PUSH_URL, "https://push.example");
});

test("after install, the terminal page is made", () => {
  assert.deepEqual(
    commands(
      steps(
        "post-install",
        { EAS_BUILD_PLATFORM: "ios", HOME },
        { hasRustup: true, root: ROOT }
      )
    ),
    [`node ${ROOT}/mobile/app/scripts/terminal-page.mjs`]
  );
});

test("a platform or phase it doesn't know is refused, not guessed", () => {
  assert.throws(
    () =>
      steps(
        "pre-install",
        { EAS_BUILD_PLATFORM: "web", HOME },
        { hasRustup: true, root: ROOT }
      ),
    PLATFORM
  );
  assert.throws(
    () =>
      steps(
        "deploy",
        { EAS_BUILD_PLATFORM: "ios", HOME },
        { hasRustup: true, root: ROOT }
      ),
    PHASE
  );
});
