import { beforeEach, expect, jest, test } from "@jest/globals";
import {
  addPushTokenListener,
  getDevicePushTokenAsync,
  requestPermissionsAsync,
} from "expo-notifications";
import { KriyonNative } from "../../modules/kriyon-native/index.ts";
import { registerPush } from "./push.ts";

jest.mock("expo-notifications", () => ({
  addPushTokenListener: jest.fn(() => ({ remove: jest.fn() })),
  getDevicePushTokenAsync: jest.fn(),
  requestPermissionsAsync: jest.fn(),
}));

jest.mock("../../modules/kriyon-native/index.ts", () => ({
  KriyonNative: { setPushToken: jest.fn() },
}));

const native = jest.mocked(KriyonNative);
const permissions = jest.mocked(requestPermissionsAsync);
const token = jest.mocked(getDevicePushTokenAsync);
const rotated = jest.mocked(addPushTokenListener);

beforeEach(() => {
  jest.clearAllMocks();
});

test("with alerts allowed, the raw push token goes to Rust", async () => {
  permissions.mockResolvedValue({ granted: true } as never);
  token.mockResolvedValue({ data: "a1b2", type: "ios" });
  native.setPushToken.mockResolvedValue(true);
  expect(await registerPush()).toBe("on");
  expect(native.setPushToken).toHaveBeenCalledWith("a1b2", "apns");
});

test("an Android token is an FCM one", async () => {
  permissions.mockResolvedValue({ granted: true } as never);
  token.mockResolvedValue({ data: "fcm-token", type: "android" });
  native.setPushToken.mockResolvedValue(true);
  await registerPush();
  expect(native.setPushToken).toHaveBeenCalledWith("fcm-token", "fcm");
});

test("alerts not allowed: nothing is asked of the push service", async () => {
  permissions.mockResolvedValue({ granted: false } as never);
  expect(await registerPush()).toBe("not allowed");
  expect(token).not.toHaveBeenCalled();
  expect(native.setPushToken).not.toHaveBeenCalled();
});

test("a build without a push sender says push is off", async () => {
  permissions.mockResolvedValue({ granted: true } as never);
  token.mockResolvedValue({ data: "a1b2", type: "ios" });
  native.setPushToken.mockResolvedValue(false);
  expect(await registerPush()).toBe("off");
});

test("no push token (the Simulator has none) is said, not thrown", async () => {
  permissions.mockResolvedValue({ granted: true } as never);
  token.mockRejectedValue(new Error("no valid aps-environment entitlement"));
  expect(await registerPush()).toBe(
    "unavailable: no valid aps-environment entitlement"
  );
});

test("a permission call that fails says so, never thrown", async () => {
  permissions.mockRejectedValue(new Error("notifications module missing"));
  expect(await registerPush()).toBe(
    "unavailable: notifications module missing"
  );
});

test("a token of another kind (a web one) is not taken for an iPhone's", async () => {
  permissions.mockResolvedValue({ granted: true } as never);
  token.mockResolvedValue({ data: {}, type: "web" } as never);
  expect(await registerPush()).toBe("unavailable: no phone push service here");
  expect(native.setPushToken).not.toHaveBeenCalled();
});

test("a token the push service renews goes to Rust again", async () => {
  permissions.mockResolvedValue({ granted: true } as never);
  token.mockResolvedValue({ data: "a1b2", type: "ios" });
  native.setPushToken.mockResolvedValue(true);
  await registerPush();
  const [listener] = rotated.mock.calls[0] as unknown as [
    (next: { data: string; type: string }) => void,
  ];
  listener({ data: "c3d4", type: "ios" });
  expect(native.setPushToken).toHaveBeenLastCalledWith("c3d4", "apns");
});
