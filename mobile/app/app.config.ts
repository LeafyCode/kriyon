/**
 * app.json, plus what can't be committed. Google's push (FCM) on Android
 * needs a Firebase project's google-services.json, which is the person's
 * own: give its path as GOOGLE_SERVICES_JSON when building. Without it the
 * app builds and runs, and alerts say they're unavailable.
 */
import { resolve } from "node:path";
import type { ConfigContext, ExpoConfig } from "expo/config";

export default ({ config }: ConfigContext): ExpoConfig => {
  // From where the command ran, as a shell reads it (Expo would read a
  // relative path from mobile/app).
  const given = process.env.GOOGLE_SERVICES_JSON;
  const googleServicesFile = given ? resolve(process.cwd(), given) : undefined;
  return {
    ...config,
    android: {
      ...config.android,
      ...(googleServicesFile ? { googleServicesFile } : {}),
    },
    name: config.name ?? "Kriyon",
    slug: config.slug ?? "kriyon",
  };
};
