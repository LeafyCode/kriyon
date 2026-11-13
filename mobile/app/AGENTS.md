# mobile/app — agent rules

Read the root `AGENTS.md` first. This is the phone app: Expo (React Native) screens in
TypeScript over the shared Rust library `crates/kriyon-mobile`, reached through our own Expo
module `modules/kriyon-native` (Swift now, Kotlin later). Plan: "How the phone app reaches
Rust" in the remote plan.

## Rules

- **Logic lives in Rust.** Pairing, reconnects, screen state, typing control and push sealing
  are `kriyon-mobile`'s. The module is a thin pass-through with no logic; the screens render
  what Rust reports. Derive and decide in a store (`src/state/`), not in a component.
- **One look with the desktop.** Colours come from the desktop's theme files
  (`src/theme/themes/`), not literals.
- **Check Expo against its current docs** (Context7, or `https://docs.expo.dev/llms.txt`):
  Expo changes every SDK, and memory of it goes stale. This is SDK 58.
- **Add packages by editing `package.json` and running `pnpm install` from the repo root**,
  with the version Expo lists for this SDK (`expo/bundledNativeModules.json`). `expo install`
  runs `pnpm add`, which can re-resolve the desktop's packages too.
- **Development build, not Expo Go**: the native module needs one. Build the Rust library
  first (`scripts/mobile/build-ios.sh`, which writes `modules/kriyon-native/ios/Rust`), then
  `pnpm ios`. The library is built for iPhones and Apple-silicon Simulators only.
- **Tests**: Jest with `jest-expo` and React Native Testing Library 14 (`render`, `fireEvent`
  and `act` are async: always `await`). Import `test` and `expect` from `@jest/globals`.
  Failing test first.
- **Checks**: `pnpm --filter @kriyon/mobile typecheck` and `... test`; Biome lints this folder
  from the root with the desktop's rules.
