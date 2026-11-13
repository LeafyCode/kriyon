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

export async function registerPush(): Promise<PushStatus> {
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
