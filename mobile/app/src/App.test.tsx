import { beforeEach, expect, jest, test } from "@jest/globals";
import { render, screen, waitFor } from "@testing-library/react-native";
import { KriyonNative } from "../modules/kriyon-native/index.ts";
import { App } from "./App.tsx";
import { usePhone } from "./state/phone.ts";

// No window to measure in Jest: the library's own stand-in, with insets.
jest.mock(
  "react-native-safe-area-context",
  () =>
    jest.requireActual<{ default: unknown }>(
      "react-native-safe-area-context/jest/mock"
    ).default
);

jest.mock("../modules/kriyon-native/index.ts", () => ({
  KriyonNative: {
    addListener: jest.fn(() => ({ remove: jest.fn() })),
    hosts: jest.fn(() => Promise.resolve([])),
    start: jest.fn(() => Promise.resolve("ef".repeat(32))),
    wake: jest.fn(),
  },
}));

jest.mock("./state/push.ts", () => ({
  pushLine: (status: string) => `Alerts: ${status}`,
  registerPush: jest.fn(() => Promise.resolve("off")),
}));

// The session screen's web view is native; home never shows it.
jest.mock("react-native-webview", () => ({ WebView: () => null }));
jest.mock("./terminal/page.generated.ts", () => ({ TERMINAL_PAGE: "" }));

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
  expect(screen.getByText("Sessions")).toBeOnTheScreen();
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

test("a session's entries from Rust reach the store", async () => {
  await render(<App />);
  const call = native.addListener.mock.calls.find(
    ([name]) => name === "onEntriesChanged"
  ) as unknown as [string, (event: unknown) => void] | undefined;
  const summary = { entries: [], unavailable: "off" };
  // A session the phone is reading.
  usePhone.setState({ reading: { [`${"ab".repeat(32)}/s1`]: true } });
  call?.[1]({ hostId: "ab".repeat(32), sessionId: "s1", summary });
  expect(usePhone.getState().readable[`${"ab".repeat(32)}/s1`]).toEqual(
    summary
  );
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

test("a start that failed (the phone was locked) is tried again when the app comes to the front", async () => {
  const { AppState } =
    jest.requireActual<typeof import("react-native")>("react-native");
  let changed: (state: string) => void = () => undefined;
  const listen = jest.spyOn(AppState, "addEventListener").mockImplementation(((
    _type: string,
    listener: (state: string) => void
  ) => {
    changed = listener;
    return { remove: jest.fn() };
  }) as never);
  native.start.mockRejectedValueOnce(
    new Error("keychain read failed (-25308)")
  );
  await render(<App />);
  await screen.findByText("keychain read failed (-25308)");
  native.start.mockResolvedValueOnce("ef".repeat(32));
  changed("active");
  await waitFor(() =>
    expect(usePhone.getState().deviceId).toBe("ef".repeat(32))
  );
  expect(usePhone.getState().startError).toBeNull();
  listen.mockRestore();
});
