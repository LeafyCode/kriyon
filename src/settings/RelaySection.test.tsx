import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";
import {
  type RelayAccount,
  type RelayView,
  relayAccount,
  relayOpenSubscriptions,
  relayRemoveDevice,
  relaySetEnabled,
  relaySignIn,
  relayThisDevice,
  relayView,
} from "../ipc/bridge.ts";
import { SAME_ACCOUNT_NOTE, useRelay } from "../state/relay.ts";
import { RelaySection } from "./RelaySection.tsx";

vi.mock("../ipc/bridge.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../ipc/bridge.ts")>()),
  onRelayChanged: vi.fn(() => Promise.resolve(() => undefined)),
  relayAccount: vi.fn(),
  relayCancelSignIn: vi.fn(),
  relayOpenSubscriptions: vi.fn(),
  relayRemoveDevice: vi.fn(),
  relaySetEnabled: vi.fn(),
  relaySignIn: vi.fn(),
  relaySignOut: vi.fn(),
  relayThisDevice: vi.fn(),
  relayView: vi.fn(),
}));

const MINE = "ab".repeat(32);
const ACTIVE = /^Active, renews automatically/;
const THIS_MAC = /This Mac \(this computer\)/;
const PHONE = /^Phone/;

const view = (over: Partial<RelayView> = {}): RelayView => ({
  available: true,
  on: false,
  passExpiresAt: null,
  problem: null,
  signedIn: false,
  signIn: null,
  ...over,
});

const account: RelayAccount = {
  blocked: false,
  deviceLimit: 10,
  devices: [
    { deviceId: "d1", deviceKey: MINE, name: "This Mac", platform: "macos" },
    {
      deviceId: "d2",
      deviceKey: "cd".repeat(32),
      name: "Phone",
      platform: "ios",
    },
  ],
  subscription: {
    paidUntil: "2026-12-13T00:00:00.000Z",
    plan: "monthly",
    state: "active",
  },
};

beforeEach(() => {
  vi.resetAllMocks();
  useRelay.setState({
    account: null,
    error: null,
    thisDeviceKey: null,
    view: null,
  });
  vi.mocked(relayThisDevice).mockResolvedValue({ deviceKey: MINE });
  vi.mocked(relayAccount).mockResolvedValue(account);
});

test("a build without a relay shows nothing of it", async () => {
  vi.mocked(relayView).mockResolvedValue(view({ available: false }));
  const { container } = render(<RelaySection />);
  await waitFor(() => expect(relayView).toHaveBeenCalled());
  expect(container).toBeEmptyDOMElement();
});

test("signed out, it offers the device sign-in and says the same-account rule", async () => {
  vi.mocked(relayView).mockResolvedValue(view());
  vi.mocked(relaySignIn).mockResolvedValue({
    userCode: "ABCD1234",
    verificationUri: "https://web.test/device",
    verificationUriComplete: "https://web.test/device?code=ABCD1234",
  });
  render(<RelaySection />);
  expect(await screen.findByText(SAME_ACCOUNT_NOTE)).toBeInTheDocument();
  vi.mocked(relayView).mockResolvedValue(
    view({
      signIn: {
        userCode: "ABCD1234",
        verificationUri: "https://web.test/device",
        verificationUriComplete: "https://web.test/device?code=ABCD1234",
      },
    })
  );
  fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
  expect(await screen.findByText("ABCD1234")).toBeInTheDocument();
  expect(screen.getByText("https://web.test/device")).toBeInTheDocument();
});

test("signed in, it shows the subscription, the devices and this computer", async () => {
  vi.mocked(relayView).mockResolvedValue(view({ signedIn: true }));
  render(<RelaySection />);
  expect(await screen.findByText(ACTIVE)).toBeInTheDocument();
  expect(screen.getByText(THIS_MAC)).toBeInTheDocument();
  expect(screen.getByText(PHONE)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Manage subscription" }));
  expect(relayOpenSubscriptions).toHaveBeenCalled();
});

test("removing a device asks first", async () => {
  vi.mocked(relayView).mockResolvedValue(view({ signedIn: true }));
  vi.mocked(relayRemoveDevice).mockResolvedValue();
  render(<RelaySection />);
  fireEvent.click(await screen.findByRole("button", { name: "Remove Phone" }));
  expect(relayRemoveDevice).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Remove" }));
  await waitFor(() => expect(relayRemoveDevice).toHaveBeenCalledWith("d2"));
});

test("turning the relay on shows a refusal in the contract's words", async () => {
  vi.mocked(relayView).mockResolvedValue(view({ signedIn: true }));
  vi.mocked(relaySetEnabled).mockRejectedValue(
    "Our relay needs a subscription"
  );
  render(<RelaySection />);
  fireEvent.click(await screen.findByRole("switch", { name: "Our relay" }));
  expect(
    await screen.findByText("Our relay needs a subscription")
  ).toBeInTheDocument();
  expect(relaySetEnabled).toHaveBeenCalledWith(true);
});

test("a problem Rust reports is shown", async () => {
  vi.mocked(relayView).mockResolvedValue(
    view({
      on: true,
      problem: "This device was removed from your relay account",
      signedIn: true,
    })
  );
  render(<RelaySection />);
  expect(
    await screen.findByText("This device was removed from your relay account")
  ).toBeInTheDocument();
});

test("an old error doesn't hide what Rust reports now", async () => {
  vi.mocked(relayView).mockResolvedValue(
    view({
      on: true,
      problem: "Relay access is suspended for this account",
      signedIn: true,
    })
  );
  vi.mocked(relayAccount).mockRejectedValue("Can't reach our relay's service");
  render(<RelaySection />);
  expect(
    await screen.findByText("Can't reach our relay's service")
  ).toBeInTheDocument();
  expect(
    screen.getByText("Relay access is suspended for this account")
  ).toBeInTheDocument();
});
