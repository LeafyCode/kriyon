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
# Usage: scripts/mobile/build-ios.sh [--debug]
set -euo pipefail

root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$root"

profile=release
cargo_profile=(--release)
if [[ "${1:-}" == "--debug" ]]; then
  profile=debug
  cargo_profile=()
fi

out="$root/mobile/app/modules/kriyon-native/ios/Rust"
targets=(aarch64-apple-ios aarch64-apple-ios-sim)

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

# The C header and module map go beside each static library, so Swift can
# import the module the generated code names.
headers="$out/Headers"
rm -rf "$headers"
mkdir -p "$headers"
cp "$generated"/*.h "$headers/"
module_name="$(basename "$generated"/*FFI.modulemap .modulemap)"
cp "$generated/$module_name.modulemap" "$headers/module.modulemap"

rm -rf "$out/KriyonMobile.xcframework"
xcodebuild -create-xcframework \
  -library "$target_dir/aarch64-apple-ios/$profile/libkriyon_mobile.a" -headers "$headers" \
  -library "$target_dir/aarch64-apple-ios-sim/$profile/libkriyon_mobile.a" -headers "$headers" \
  -output "$out/KriyonMobile.xcframework"

echo "build-ios: $out"
