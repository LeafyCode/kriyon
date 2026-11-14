/**
 * app.json, plus what can't be committed. Google's push (FCM) on Android
 * needs a Firebase project's google-services.json, which is the person's
 * own: give its path as GOOGLE_SERVICES_JSON when building. Without it the
 * app builds and runs, and Home says alerts need a Firebase setup. On EAS
 * Build, GOOGLE_SERVICES_JSON is a file variable of the Expo project.
 *
 * The version is the release's (scripts/release.mjs sets it in app.json),
 * as the stores take it (src/storeVersion.ts).
 */
import { relative, resolve } from "node:path";
import type { ConfigContext, ExpoConfig } from "expo/config";
import { storeVersion } from "./src/storeVersion.ts";

export default ({ config }: ConfigContext): ExpoConfig => {
  // From where the command ran, as a shell reads it, then relative to this
  // folder (where Expo reads it from), so the app's built-in config never
  // carries a path from the builder's computer.
  const given = process.env.GOOGLE_SERVICES_JSON;
  const googleServicesFile = given
    ? relative(import.meta.dirname, resolve(process.cwd(), given))
    : undefined;
  return {
    ...config,
    android: {
      ...config.android,
      ...(googleServicesFile ? { googleServicesFile } : {}),
    },
    name: config.name ?? "Kriyon",
    slug: config.slug ?? "kriyon",
    version: config.version ? storeVersion(config.version) : undefined,
  };
};
