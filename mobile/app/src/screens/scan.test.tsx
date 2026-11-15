import { beforeEach, expect, jest, test } from "@jest/globals";
import { act, fireEvent, render, screen } from "@testing-library/react-native";
import { useCameraPermissions } from "expo-camera";
import { BackHandler, Linking } from "react-native";
import { KriyonNative } from "../../modules/kriyon-native/index.ts";
import { usePhone } from "../state/phone.ts";
import { PairScreen } from "./PairScreen.tsx";

let scanned: ((result: { data: string; type: string }) => void) | undefined;
let mountError: ((event: { message: string }) => void) | undefined;

jest.mock("expo-camera", () => {
  const { View } =
    jest.requireActual<typeof import("react-native")>("react-native");
  return {
    CameraView: (props: {
      onBarcodeScanned?: typeof scanned;
      onMountError?: typeof mountError;
    }) => {
      scanned = props.onBarcodeScanned;
      mountError = props.onMountError;
      return <View testID="camera" />;
    },
    useCameraPermissions: jest.fn(),
  };
});

jest.mock("../../modules/kriyon-native/index.ts", () => ({
  KriyonNative: {
    cancelPairing: jest.fn(() => Promise.resolve()),
    finishPairing: jest.fn(() => new Promise(() => undefined)),
    hosts: jest.fn(() => Promise.resolve([])),
    pair: jest.fn(() => Promise.resolve("123456")),
  },
}));

const permissions = jest.mocked(useCameraPermissions);
const native = jest.mocked(KriyonNative);
const ask = jest.fn(() => Promise.resolve());
const CODE = `kriyon-pair:1:${"ab".repeat(40)}`;

beforeEach(() => {
  jest.clearAllMocks();
  usePhone.setState(usePhone.getInitialState());
});

test("scanning asks for the camera in plain words first", async () => {
  permissions.mockReturnValue([
    { granted: false, canAskAgain: true } as never,
    ask,
    jest.fn(),
  ] as never);
  await render(<PairScreen />);
  await fireEvent.press(
    screen.getByRole("button", { name: "Scan the QR code" })
  );
  expect(
    screen.getByText(
      "Kriyon uses the camera only to scan the pairing code your computer shows."
    )
  ).toBeOnTheScreen();
  await fireEvent.press(
    screen.getByRole("button", { name: "Allow the camera" })
  );
  expect(ask).toHaveBeenCalled();
});

test("a refused camera points to Settings and leaves paste", async () => {
  permissions.mockReturnValue([
    { granted: false, canAskAgain: false } as never,
    ask,
    jest.fn(),
  ] as never);
  await render(<PairScreen />);
  await fireEvent.press(
    screen.getByRole("button", { name: "Scan the QR code" })
  );
  expect(
    screen.getByText(
      "The camera is off for Kriyon. Turn it on in Settings, or paste the pairing code instead."
    )
  ).toBeOnTheScreen();
  expect(
    screen.getByLabelText("Pairing code from the computer")
  ).toBeOnTheScreen();
});

test("a scanned pairing code pairs once; anything else says what it is", async () => {
  permissions.mockReturnValue([
    { granted: true } as never,
    ask,
    jest.fn(),
  ] as never);
  await render(<PairScreen />);
  await fireEvent.press(
    screen.getByRole("button", { name: "Scan the QR code" })
  );
  expect(screen.getByTestId("camera")).toBeOnTheScreen();
  await act(() => scanned?.({ data: "https://example.com", type: "qr" }));
  expect(
    screen.getByText("That isn't a Kriyon pairing code.")
  ).toBeOnTheScreen();
  expect(native.pair).not.toHaveBeenCalled();
  await act(() => scanned?.({ data: CODE, type: "qr" }));
  expect(native.pair).toHaveBeenCalledTimes(1);
  expect(native.pair).toHaveBeenCalledWith(CODE);
  expect(screen.queryByTestId("camera")).toBeNull();
  expect(
    await screen.findByLabelText("Pairing code 1 2 3 4 5 6")
  ).toBeOnTheScreen();
});

test("while the permission is still being read, nothing asks", async () => {
  permissions.mockReturnValue([null, ask, jest.fn()] as never);
  await render(<PairScreen />);
  await fireEvent.press(
    screen.getByRole("button", { name: "Scan the QR code" })
  );
  expect(screen.queryByRole("button", { name: "Allow the camera" })).toBeNull();
});

test("a refused camera has a way to Settings", async () => {
  const openSettings = jest
    .spyOn(Linking, "openSettings")
    .mockResolvedValue(undefined as never);
  permissions.mockReturnValue([
    { granted: false, canAskAgain: false } as never,
    ask,
    jest.fn(),
  ] as never);
  await render(<PairScreen />);
  await fireEvent.press(
    screen.getByRole("button", { name: "Scan the QR code" })
  );
  await fireEvent.press(screen.getByRole("button", { name: "Open Settings" }));
  expect(openSettings).toHaveBeenCalled();
});

test("scanning can be stopped, and a camera that won't start says so", async () => {
  permissions.mockReturnValue([
    { granted: true } as never,
    ask,
    jest.fn(),
  ] as never);
  await render(<PairScreen />);
  await fireEvent.press(
    screen.getByRole("button", { name: "Scan the QR code" })
  );
  await act(() => mountError?.({ message: "no camera" }));
  expect(
    screen.getByText(
      "The camera didn't start (no camera). Paste the pairing code instead."
    )
  ).toBeOnTheScreen();
  await fireEvent.press(screen.getByRole("button", { name: "Stop scanning" }));
  expect(screen.queryByTestId("camera")).toBeNull();
});

test("while a pairing runs, scanning and pasting are not offered", async () => {
  permissions.mockReturnValue([
    { granted: true } as never,
    ask,
    jest.fn(),
  ] as never);
  usePhone.setState({ pairing: { code: "123456", phase: "code" } });
  await render(<PairScreen />);
  expect(screen.queryByRole("button", { name: "Scan the QR code" })).toBeNull();
  expect(screen.queryByLabelText("Pairing code from the computer")).toBeNull();
});

test("pasted text that isn't a pairing code is said so before Rust", async () => {
  await usePhone.getState().pair("hello");
  expect(native.pair).not.toHaveBeenCalled();
  expect(usePhone.getState().pairing).toEqual({
    phase: "failed",
    reason: "That isn't a Kriyon pairing code.",
  });
});

test("Back while scanning stops the camera and stays on pairing", async () => {
  permissions.mockReturnValue([
    { granted: true } as never,
    ask,
    jest.fn(),
  ] as never);
  const listen = jest.spyOn(BackHandler, "addEventListener");
  usePhone.setState({ screen: { kind: "pair" } });
  await render(<PairScreen />);
  await fireEvent.press(
    screen.getByRole("button", { name: "Scan the QR code" })
  );
  expect(screen.getByTestId("camera")).toBeOnTheScreen();
  const onBack = listen.mock.calls.at(-1)?.[1] as (() => boolean) | undefined;
  let handled = false;
  await act(() => {
    handled = onBack?.() ?? false;
  });
  expect(handled).toBe(true);
  expect(screen.queryByTestId("camera")).toBeNull();
  expect(usePhone.getState().screen).toEqual({ kind: "pair" });
  expect(native.cancelPairing).not.toHaveBeenCalled();
  listen.mockRestore();
});
