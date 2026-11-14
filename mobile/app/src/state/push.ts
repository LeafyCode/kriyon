/**
 * Phone alerts: ask to show them, get this phone's raw push token from
 * Apple or Google (not Expo's push service), and give it to Rust, which
 * seals it for each paired computer. A token the push service renews goes
 * to Rust again. The alert itself only ever says that a session needs you.
 */
import {
  addPushTokenListener,
  type DevicePushToken,
  type EventSubscription,
  getDevicePushTokenAsync,
  requestPermissionsAsync,
} from "expo-notifications";
import { KriyonNative } from "../../modules/kriyon-native/index.ts";

/** Where alerts stand, in words the settings can show. */
export type PushStatus =
  | "on"
  | "off"
  /** An Android build made without the person's Firebase file. */
  | "needs Firebase"
  | "not allowed"
  | `unavailable: ${string}`;

/** Apple's or Google's service for a token; anything else has none here. */
function serviceFor(token: DevicePushToken): "apns" | "fcm" | null {
  switch (token.type) {
    case "ios":
      return "apns";
    case "android":
      return "fcm";
    default:
      return null;
  }
}

/** Give Rust `token`; whether push is on. */
async function give(token: DevicePushToken): Promise<PushStatus> {
  const service = serviceFor(token);
  if (!service) {
    return "unavailable: no phone push service here";
  }
  const on = await KriyonNative.setPushToken(String(token.data), service);
  return on ? "on" : "off";
}

let renewals: EventSubscription | null = null;

/** Where alerts stand, in a word for Settings' row. */
export function alertsWord(status: PushStatus | null): {
  label: string;
  tone: "amber" | "green" | "plain";
} {
  switch (status) {
    case null:
      return { label: "Checking…", tone: "plain" };
    case "on":
      return { label: "On", tone: "green" };
    case "off":
      return { label: "Off", tone: "plain" };
    case "not allowed":
      return { label: "Not allowed", tone: "amber" };
    case "needs Firebase":
      return { label: "Needs setup", tone: "amber" };
    default:
      return { label: "Unavailable", tone: "amber" };
  }
}

/** The alerts line on Home. */
export function pushLine(status: PushStatus): string {
  return status === "needs Firebase"
    ? "Alerts need a Firebase setup on this build."
    : `Alerts: ${status}`;
}

export async function registerPush(): Promise<PushStatus> {
  if (!KriyonNative.hasPushService()) {
    // An Android build without the person's Firebase file (app.config.ts):
    // no token can come, so don't ask to show alerts that can't arrive.
    return "needs Firebase";
  }
  try {
    const allowed = await requestPermissionsAsync();
    if (!allowed.granted) {
      return "not allowed";
    }
    const status = await give(await getDevicePushTokenAsync());
    // One listener at a time: a later registration replaces this one.
    renewals?.remove();
    renewals =
      status === "on"
        ? addPushTokenListener((next) => {
            give(next).catch(() => undefined);
          })
        : null;
    return status;
  } catch (error) {
    return `unavailable: ${error instanceof Error ? error.message : String(error)}`;
  }
}
