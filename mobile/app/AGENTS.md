# mobile/app — agent rules

Read the root `AGENTS.md` first. This is the phone app: Expo (React Native) screens in
TypeScript over the shared Rust library `crates/kriyon-mobile`, reached through our own Expo
module `modules/kriyon-native` (Swift on iPhone, Kotlin on Android, the same calls). Plan:
"How the phone app reaches Rust" in the remote plan.

## Rules

- **Logic lives in Rust.** Pairing, reconnects, screen state, typing control and push sealing
  are `kriyon-mobile`'s. The module is a thin pass-through with no logic; the screens render
  what Rust reports. Derive and decide in a store (`src/state/`), not in a component.
- **One look, light and dark.** Colours and fonts come from `src/theme.ts` (the mobile design's
  tokens, sharing the desktop's Steel accent) through `useTheme`/`useLook`, never as literals.
  Shared pieces (pills, buttons, cards) are in `src/kit.tsx`: status is always a word, never
  colour alone, and every tap target is at least 44 points with a label. A text colour pair
  is added to `src/theme.test.ts`, which holds both modes to 4.5:1.
- **Screen readers, large text and reduced motion.** A control reads its name, role and state
  (`src/screens/a11y.test.tsx` holds them, queried by role and label); something read as one
  thing (a card's count, a step) is one `accessible` view. At large text (`useLargeText`) a
  pill goes under its title instead of squeezing it; motion follows `useReduceMotion`. Check
  on the emulator with TalkBack and `font_scale` 2.0: Jest renders as iOS, so an Android-only
  difference (a sheet's scrim, the web view's text zoom) shows only there.
- **Check Expo against its current docs** (Context7, or `https://docs.expo.dev/llms.txt`):
  Expo changes every SDK, and memory of it goes stale. This is SDK 58.
- **Add packages by editing `package.json` and running `pnpm install` from the repo root**,
  with the version Expo lists for this SDK (`expo/bundledNativeModules.json`). `expo install`
  runs `pnpm add`, which can re-resolve the desktop's packages too.
- **Development build, not Expo Go**: the native module needs one. Build the Rust library
  first, then the app: `scripts/mobile/build-ios.sh` (writes `modules/kriyon-native/ios/Rust`)
  and `pnpm ios`, or `scripts/mobile/build-android.sh` (writes
  `modules/kriyon-native/android/rust`) and `pnpm android`. The library is built for 64-bit
  Arm only: iPhones, Android phones, and Apple-silicon Simulators and emulators.
- **Both modules make the same calls.** Rust speaks JSON; Swift and Kotlin pass it on as it
  is, and a call added to one is added to the other.
- **Android push needs the person's Firebase file** (`google-services.json`), given as
  `GOOGLE_SERVICES_JSON` when building (`app.config.ts`). Never commit it.
- **Tests**: Jest with `jest-expo` and React Native Testing Library 14 (`render`, `fireEvent`
  and `act` are async: always `await`). Import `test` and `expect` from `@jest/globals`.
  Failing test first.
- **Checks**: `pnpm --filter @kriyon/mobile typecheck` and `... test`; Biome lints this folder
  from the root with the desktop's rules.
