import { beforeEach, expect, jest, test } from "@jest/globals";
import { fireEvent, render, screen } from "@testing-library/react-native";
import {
  authenticateAsync,
  getEnrolledLevelAsync,
} from "expo-local-authentication";
import { usePhone } from "../state/phone.ts";
import { LockScreen } from "./LockScreen.tsx";

jest.mock("expo-local-authentication", () => ({
  authenticateAsync: jest.fn(),
  getEnrolledLevelAsync: jest.fn(),
  SecurityLevel: { BIOMETRIC_STRONG: 3, BIOMETRIC_WEAK: 2, NONE: 0, SECRET: 1 },
}));

jest.mock("../../modules/kriyon-native/index.ts", () => ({
  KriyonNative: {
    setAppLock: jest.fn(() => Promise.resolve()),
    setPrivateInSwitcher: jest.fn(() => Promise.resolve()),
  },
}));

const auth = {
  authenticateAsync: jest.mocked(authenticateAsync),
  getEnrolledLevelAsync: jest.mocked(getEnrolledLevelAsync),
};
const NO_PASSCODE = /has no passcode/;
const LOCKOUT = /lockout/;

beforeEach(() => {
  jest.clearAllMocks();
  usePhone.setState({
    ...usePhone.getInitialState(),
    appLock: { afterS: 300, on: true },
    lock: { awayAtMs: null, locked: true },
  });
});

test("the lock asks the phone at once, and again with Unlock", async () => {
  auth.getEnrolledLevelAsync.mockResolvedValue(3);
  auth.authenticateAsync.mockResolvedValue({
    error: "user_cancel",
    success: false,
  });
  await render(<LockScreen />);
  expect(auth.authenticateAsync).toHaveBeenCalledTimes(1);
  await fireEvent.press(screen.getByRole("button", { name: "Unlock" }));
  expect(auth.authenticateAsync).toHaveBeenCalledTimes(2);
});

test("a phone with no passcode is told so plainly, and may go on", async () => {
  auth.getEnrolledLevelAsync.mockResolvedValue(0);
  await render(<LockScreen />);
  expect(await screen.findByText(NO_PASSCODE)).toBeOnTheScreen();
  await fireEvent.press(screen.getByRole("button", { name: "Continue" }));
  expect(usePhone.getState().lock.locked).toBe(false);
});

test("a lock the phone couldn't check says why, and Try again asks again", async () => {
  auth.getEnrolledLevelAsync.mockResolvedValue(3);
  auth.authenticateAsync.mockResolvedValue({
    error: "lockout",
    success: false,
  });
  await render(<LockScreen />);
  expect(await screen.findByText(LOCKOUT)).toBeOnTheScreen();
  await fireEvent.press(screen.getByRole("button", { name: "Try again" }));
  expect(auth.authenticateAsync).toHaveBeenCalledTimes(2);
});
