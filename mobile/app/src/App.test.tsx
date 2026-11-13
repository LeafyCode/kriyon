import { beforeEach, expect, jest, test } from "@jest/globals";
import { render, screen, waitFor } from "@testing-library/react-native";
import { KriyonNative } from "../modules/kriyon-native/index.ts";
import { App } from "./App.tsx";
import { usePhone } from "./state/phone.ts";

jest.mock("../modules/kriyon-native/index.ts", () => ({
  KriyonNative: {
    addListener: jest.fn(() => ({ remove: jest.fn() })),
    hosts: jest.fn(() => Promise.resolve([])),
    start: jest.fn(() => Promise.resolve("ef".repeat(32))),
    wake: jest.fn(),
  },
}));

const native = jest.mocked(KriyonNative);

beforeEach(() => {
  jest.clearAllMocks();
  usePhone.setState(usePhone.getInitialState());
});

test("the app starts Rust once, listens for its computers and opens on home", async () => {
  await render(<App />);
  await waitFor(() =>
    expect(usePhone.getState().deviceId).toBe("ef".repeat(32))
  );
  expect(native.start).toHaveBeenCalledTimes(1);
  expect(native.addListener).toHaveBeenCalledWith(
    "onHostChanged",
    expect.any(Function)
  );
  expect(screen.getByText("Kriyon")).toBeOnTheScreen();
});

test("what Rust says about a computer reaches the store", async () => {
  await render(<App />);
  const [, listener] = native.addListener.mock.calls[0] as unknown as [
    string,
    (state: unknown) => void,
  ];
  listener({
    hostId: "ab".repeat(32),
    hostName: "Mac",
    link: "connected",
    refused: null,
    role: "viewer",
    sessions: [],
  });
  expect(usePhone.getState().states["ab".repeat(32)]?.hostName).toBe("Mac");
});

test("a start that fails says so instead of an empty home", async () => {
  native.start.mockRejectedValueOnce(
    new Error("keychain read failed (-25308)")
  );
  await render(<App />);
  expect(
    await screen.findByText("keychain read failed (-25308)")
  ).toBeOnTheScreen();
});
