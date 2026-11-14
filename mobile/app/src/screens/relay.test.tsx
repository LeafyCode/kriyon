import { beforeEach, expect, jest, test } from "@jest/globals";
import {
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react-native";
import { Linking } from "react-native";
import {
  KriyonNative,
  type PhoneRelay,
} from "../../modules/kriyon-native/index.ts";
import { useRelay } from "../state/relay.ts";
import { RelaySection } from "./RelaySection.tsx";

jest.mock("../../modules/kriyon-native/index.ts", () => ({
  KriyonNative: {
    relay: jest.fn(),
    relayAccount: jest.fn(),
    relayCancelSignIn: jest.fn(() => Promise.resolve()),
    relaySetOn: jest.fn(),
    relaySignIn: jest.fn(),
    relaySignOut: jest.fn(),
    relayWaitSignIn: jest.fn(),
  },
}));

const SAME_ACCOUNT = /Sign in with the same account on your computer\./;
const MANAGED_THERE = /^Subscriptions are managed on your computer\./;
const native = jest.mocked(KriyonNative);
const BUY = /Subscribe|Manage/;
const ACTIVE = /^Active, renews automatically/;

const view = (over: Partial<PhoneRelay> = {}): PhoneRelay => ({
  available: true,
  on: false,
  passExpiresAt: null,
  problem: null,
  signedIn: false,
  signIn: null,
  ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
  useRelay.setState(useRelay.getInitialState());
});

test("a build without a relay shows nothing of it", async () => {
  native.relay.mockResolvedValue(view({ available: false }));
  await render(<RelaySection />);
  await waitFor(() => expect(native.relay).toHaveBeenCalled());
  expect(screen.queryByText("Our relay")).toBeNull();
});

test("signing in shows the code, opens the browser and waits", async () => {
  const opened = jest
    .spyOn(Linking, "openURL")
    .mockResolvedValue(true as never);
  native.relay.mockResolvedValue(view());
  native.relaySignIn.mockResolvedValue({
    userCode: "ABCD1234",
    verificationUri: "https://web.test/device",
    verificationUriComplete: "https://web.test/device?code=ABCD1234",
  });
  native.relayWaitSignIn.mockReturnValue(new Promise(() => undefined));
  await render(<RelaySection />);
  await fireEvent.press(await screen.findByRole("button", { name: "Sign in" }));
  expect(await screen.findByText("ABCD1234")).toBeOnTheScreen();
  expect(opened).toHaveBeenCalledWith("https://web.test/device?code=ABCD1234");
  expect(native.relayWaitSignIn).toHaveBeenCalled();
  expect(screen.getByText(SAME_ACCOUNT)).toBeOnTheScreen();
});

test("signed in, it shows the subscription only, with no way to buy", async () => {
  native.relay.mockResolvedValue(view({ on: true, signedIn: true }));
  native.relayAccount.mockResolvedValue({
    blocked: false,
    deviceLimit: 10,
    devices: [],
    paidUntil: null,
    state: null,
  });
  await render(<RelaySection />);
  expect(await screen.findByText("No subscription yet.")).toBeOnTheScreen();
  expect(screen.queryByText(BUY)).toBeNull();
  expect(screen.getByText(MANAGED_THERE)).toBeOnTheScreen();
});

test("turning the relay off asks Rust, and a refusal shows in its words", async () => {
  native.relay.mockResolvedValue(view({ on: true, signedIn: true }));
  native.relayAccount.mockResolvedValue({
    blocked: false,
    deviceLimit: 10,
    devices: [],
    paidUntil: null,
    state: null,
  });
  native.relaySetOn.mockRejectedValue(
    new Error("Our relay needs a subscription")
  );
  await render(<RelaySection />);
  await fireEvent(
    await screen.findByRole("switch", { name: "Our relay" }),
    "valueChange",
    false
  );
  expect(native.relaySetOn).toHaveBeenCalledWith(false);
  expect(
    await screen.findByText("Our relay needs a subscription")
  ).toBeOnTheScreen();
});

test("a waiting sign-in can be cancelled or its page opened again", async () => {
  const opened = jest
    .spyOn(Linking, "openURL")
    .mockResolvedValue(true as never);
  native.relay.mockResolvedValue(
    view({
      signIn: {
        userCode: "ABCD1234",
        verificationUri: "https://web.test/device",
        verificationUriComplete: "https://web.test/device?code=ABCD1234",
      },
    })
  );
  await render(<RelaySection />);
  await fireEvent.press(
    await screen.findByRole("button", { name: "Open the page again" })
  );
  expect(opened).toHaveBeenCalledWith("https://web.test/device?code=ABCD1234");
  native.relay.mockResolvedValue(view());
  await fireEvent.press(screen.getByRole("button", { name: "Cancel" }));
  expect(native.relayCancelSignIn).toHaveBeenCalled();
  expect(
    await screen.findByRole("button", { name: "Sign in" })
  ).toBeOnTheScreen();
});

test("turning the relay on reads the account again; a reload keeps the old until the new comes", async () => {
  const account = {
    blocked: false,
    deviceLimit: 10,
    devices: [],
    paidUntil: null,
    state: null,
  };
  native.relay.mockResolvedValue(view({ signedIn: true }));
  native.relayAccount.mockResolvedValue(account);
  native.relaySetOn.mockResolvedValue(view({ on: true, signedIn: true }));
  await render(<RelaySection />);
  await screen.findByText("No subscription yet.");
  native.relayAccount.mockResolvedValue({
    ...account,
    state: "active",
    paidUntil: "2026-12-13T00:00:00.000Z",
  });
  await fireEvent(
    screen.getByRole("switch", { name: "Our relay" }),
    "valueChange",
    true
  );
  expect(await screen.findByText(ACTIVE)).toBeOnTheScreen();
  native.relayAccount.mockRejectedValue(
    new Error("Can't reach our relay's service")
  );
  await useRelay.getState().load();
  expect(screen.getByText(ACTIVE)).toBeOnTheScreen();
});
