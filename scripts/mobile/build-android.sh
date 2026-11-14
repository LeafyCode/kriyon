#!/usr/bin/env bash
# Build the phone's Rust library (crates/kriyon-mobile) for Android: a shared
# library for 64-bit Arm phones (and the Arm emulator on an Apple-silicon
# Mac), with the Kotlin bindings UniFFI generates from it.
#
# Not part of `pnpm check`: it needs the Android NDK and the Rust target,
# which desktop work doesn't. Plain cargo with the NDK's clang as linker, so
# no cargo-ndk. Output goes where the Expo module's build.gradle looks:
#   mobile/app/modules/kriyon-native/android/rust/jniLibs/arm64-v8a/libkriyon_mobile.so
#   mobile/app/modules/kriyon-native/android/rust/kotlin/uniffi/kriyon_mobile/*.kt
#
# The NDK is ANDROID_NDK_HOME, or the one React Native asks for under
# ANDROID_HOME (default ~/Library/Android/sdk).
#
# Usage: scripts/mobile/build-android.sh [--debug]
set -euo pipefail

root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$root"

profile=release
cargo_profile=(--release)
if [[ "${1:-}" == "--debug" ]]; then
  profile=debug
  cargo_profile=()
fi

# The app's minSdk (28, app.json's expo-build-properties: keys that open only
# while unlocked need Android 9) and React Native 0.88's NDK 27.1
# (react-native/gradle/libs.versions.toml).
api=28
ndk_version=27.1.12297006
target=aarch64-linux-android
abi=arm64-v8a

sdk="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
ndk="${ANDROID_NDK_HOME:-$sdk/ndk/$ndk_version}"
case "$(uname -s)" in
  Darwin) host=darwin-x86_64 ;; # one folder for both Mac chips
  Linux) host=linux-x86_64 ;;
  *) echo "build-android: only macOS and Linux are set up" >&2; exit 1 ;;
esac
bin="$ndk/toolchains/llvm/prebuilt/$host/bin"
[[ -x "$bin/clang" ]] || { echo "build-android: no NDK at $ndk (install NDK $ndk_version)" >&2; exit 1; }

if ! rustup target list --installed | grep -qx "$target"; then
  echo "build-android: adding the Rust target $target"
  rustup target add "$target"
fi

# The NDK's clang links, and builds any C a dependency compiles.
export CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER="$bin/$target$api-clang"
export CC_aarch64_linux_android="$bin/$target$api-clang"
export AR_aarch64_linux_android="$bin/llvm-ar"
# 16 KB pages: Android 15+ phones may use them, and Google Play requires it.
# NDK 27 still lays libraries out for 4 KB by default.
export CARGO_TARGET_AARCH64_LINUX_ANDROID_RUSTFLAGS="-C link-arg=-Wl,-z,max-page-size=16384"

# Where Cargo puts what it builds (CARGO_TARGET_DIR and config included).
target_dir="$(cargo metadata --no-deps --format-version 1 |
  python3 -c 'import json, sys; print(json.load(sys.stdin)["target_directory"])')"

# Not stripped yet: the bindings are read from its UniFFI metadata symbols.
CARGO_PROFILE_RELEASE_STRIP=false cargo rustc -p kriyon-mobile --lib --crate-type cdylib \
  --target "$target" ${cargo_profile[@]+"${cargo_profile[@]}"}
built="$target_dir/$target/$profile/libkriyon_mobile.so"

out="$root/mobile/app/modules/kriyon-native/android/rust"
rm -rf "$out"
mkdir -p "$out/jniLibs/$abi" "$out/kotlin"

# Kotlin bindings, read from the Android library itself (library mode).
cargo run -q -p kriyon-mobile --features bindgen --bin uniffi-bindgen -- \
  generate --library "$built" --language kotlin --no-format --out-dir "$out/kotlin"

# The app carries it stripped: a fraction of the size.
"$bin/llvm-strip" --strip-unneeded -o "$out/jniLibs/$abi/libkriyon_mobile.so" "$built"

echo "build-android: $out"
