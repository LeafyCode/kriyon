#!/usr/bin/env bash
# Build the phone's Rust library (crates/kriyon-mobile) for iOS: a static
# library for devices and one for the Simulator (Apple Silicon), wrapped as
# an XCFramework, with the Swift bindings UniFFI generates from it.
#
# Not part of `pnpm check`: it needs Xcode and the iOS Rust targets, which
# desktop work doesn't. Output goes where the Expo module's podspec looks:
#   mobile/app/modules/kriyon-native/ios/Rust/KriyonMobile.xcframework
#   mobile/app/modules/kriyon-native/ios/Rust/Generated/*.swift
#
# Usage: scripts/mobile/build-ios.sh [--debug] [--device-only]
#   --device-only  iPhones only, no Simulator slice: for store and shared
#                  builds (EAS), which only ever install on phones.
set -euo pipefail

root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$root"

profile=release
cargo_profile=(--release)
targets=(aarch64-apple-ios aarch64-apple-ios-sim)
for arg in "$@"; do
  case "$arg" in
    --debug)
      profile=debug
      cargo_profile=()
      ;;
    --device-only) targets=(aarch64-apple-ios) ;;
    *) echo "build-ios: unknown option $arg" >&2; exit 1 ;;
  esac
done

out="$root/mobile/app/modules/kriyon-native/ios/Rust"

command -v xcodebuild >/dev/null || { echo "build-ios: Xcode is needed" >&2; exit 1; }
for target in "${targets[@]}"; do
  if ! rustup target list --installed | grep -qx "$target"; then
    echo "build-ios: adding the Rust target $target"
    rustup target add "$target"
  fi
done

# Where Cargo puts what it builds (CARGO_TARGET_DIR and config included).
target_dir="$(cargo metadata --no-deps --format-version 1 |
  python3 -c 'import json, sys; print(json.load(sys.stdin)["target_directory"])')"

export IPHONEOS_DEPLOYMENT_TARGET=15.1
for target in "${targets[@]}"; do
  cargo rustc -p kriyon-mobile --lib --crate-type staticlib --target "$target" \
    ${cargo_profile[@]+"${cargo_profile[@]}"}
done

# Swift bindings, read from a library built for this Mac (library mode). Not
# stripped: the bindings are read from its UniFFI metadata symbols.
CARGO_PROFILE_RELEASE_STRIP=false cargo rustc -p kriyon-mobile --lib --crate-type cdylib \
  ${cargo_profile[@]+"${cargo_profile[@]}"}
generated="$out/Generated"
rm -rf "$generated"
mkdir -p "$generated"
cargo run -q -p kriyon-mobile --features bindgen --bin uniffi-bindgen -- \
  generate --library "$target_dir/$profile/libkriyon_mobile.dylib" \
  --language swift --out-dir "$generated"

# The C header the bindings call is compiled into the Expo module's pod
# (its podspec lists Rust/Generated/*.h), so the XCFramework carries the
# libraries only and the header lives in one place.
rm -rf "$out/Headers"

rm -rf "$out/KriyonMobile.xcframework"
libraries=()
for target in "${targets[@]}"; do
  libraries+=(-library "$target_dir/$target/$profile/libkriyon_mobile.a")
done
xcodebuild -create-xcframework "${libraries[@]}" -output "$out/KriyonMobile.xcframework"

echo "build-ios: $out"
