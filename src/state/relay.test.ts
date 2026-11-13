import { beforeEach, expect, test, vi } from "vitest";
import {
  type RelayAccount,
  type RelayView,
  relayAccount,
  relayRemoveDevice,
  relaySetEnabled,
  relaySignIn,
  relayThisDevice,
  relayView,
} from "../ipc/bridge.ts";
import {
  consentLines,
  RELAY_CONSENT_LINE,
  subscribeLabel,
  subscriptionLine,
  useRelay,
} from "./relay.ts";
import { CONSENT_LINES } from "./remote.ts";

vi.mock("../ipc/bridge.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../ipc/bridge.ts")>()),
  relayAccount: vi.fn(),
  relayRemoveDevice: vi.fn(),
  relaySetEnabled: vi.fn(),
  relaySignIn: vi.fn(),
  relayThisDevice: vi.fn(),
  relayView: vi.fn(),
}));

const ACTIVE = /^Active, renews automatically\. Paid until/;
const DECLINED = /renewal payment was declined/;
const CANCELED = /^Canceled\. Paid time until .* still counts\./;

const view = (over: Partial<RelayView> = {}): RelayView => ({
  available: true,
  on: false,
  passExpiresAt: null,
  problem: null,
  signedIn: false,
  signIn: null,
  ...over,
});

const account = (
  subscription: RelayAccount["subscription"] = null
): RelayAccount => ({
  blocked: false,
  deviceLimit: 10,
  devices: [
    {
      deviceId: "d1",
      deviceKey: "ab".repeat(32),
      name: "Mac",
      platform: "macos",
    },
  ],
  subscription,
});

beforeEach(() => {
  vi.resetAllMocks();
  useRelay.setState({
    account: null,
    error: null,
    thisDeviceKey: null,
    view: null,
  });
});

test("the consent screen names the relay only while it is on", () => {
  expect(consentLines(false)).toEqual(CONSENT_LINES);
  expect(consentLines(true)).toEqual([...CONSENT_LINES, RELAY_CONSENT_LINE]);
  expect(RELAY_CONSENT_LINE).toContain(
    "Through our relay, traffic passes a server that can't read it"
  );
});

test("each subscription state reads in plain words", () => {
  const paid = (state: NonNullable<RelayAccount["subscription"]>["state"]) =>
    subscriptionLine(
      account({ paidUntil: "2026-12-13T00:00:00.000Z", plan: "monthly", state })
    );
  expect(subscriptionLine(account())).toBe("No subscription yet.");
  expect(paid("pending")).toBe("A first payment is waiting to be confirmed.");
  expect(paid("active")).toMatch(ACTIVE);
  expect(paid("past_due")).toMatch(DECLINED);
  expect(paid("canceled")).toMatch(CANCELED);
  expect(paid("expired")).toBe("Expired: the renewal failed.");
  expect(subscriptionLine({ ...account(), blocked: true })).toBe(
    "Relay access is suspended for this account."
  );
});

test("the website button subscribes when there is nothing to manage", () => {
  expect(subscribeLabel(null)).toBe("Subscribe");
  expect(subscribeLabel(account())).toBe("Subscribe");
  expect(
    subscribeLabel(
      account({ paidUntil: "x", plan: "monthly", state: "expired" })
    )
  ).toBe("Subscribe");
  expect(
    subscribeLabel(
      account({ paidUntil: "x", plan: "monthly", state: "active" })
    )
  ).toBe("Manage subscription");
});

test("loading signed in reads the account and this computer's key", async () => {
  vi.mocked(relayView).mockResolvedValue(view({ signedIn: true }));
  vi.mocked(relayAccount).mockResolvedValue(account());
  vi.mocked(relayThisDevice).mockResolvedValue({ deviceKey: "ab".repeat(32) });
  await useRelay.getState().load();
  const state = useRelay.getState();
  expect(state.account?.devices[0]?.name).toBe("Mac");
  expect(state.thisDeviceKey).toBe("ab".repeat(32));
});

test("loading signed out asks the account nothing", async () => {
  vi.mocked(relayView).mockResolvedValue(view());
  await useRelay.getState().load();
  expect(relayAccount).not.toHaveBeenCalled();
  expect(useRelay.getState().account).toBeNull();
});

test("a refusal shows in the contract's words", async () => {
  vi.mocked(relaySetEnabled).mockRejectedValue(
    "Our relay needs a subscription"
  );
  await useRelay.getState().setOn(true);
  expect(useRelay.getState().error).toBe("Our relay needs a subscription");
});

test("signing in shows the code at once", async () => {
  vi.mocked(relaySignIn).mockResolvedValue({
    userCode: "ABCD1234",
    verificationUri: "https://web.test/device",
    verificationUriComplete: "https://web.test/device?code=ABCD1234",
  });
  vi.mocked(relayView).mockResolvedValue(
    view({
      signIn: {
        userCode: "ABCD1234",
        verificationUri: "https://web.test/device",
        verificationUriComplete: "https://web.test/device?code=ABCD1234",
      },
    })
  );
  await useRelay.getState().signIn();
  expect(useRelay.getState().view?.signIn?.userCode).toBe("ABCD1234");
});

test("removing a device reads the account again", async () => {
  vi.mocked(relayRemoveDevice).mockResolvedValue();
  vi.mocked(relayAccount).mockResolvedValue({ ...account(), devices: [] });
  await useRelay.getState().removeDevice("d1");
  expect(relayRemoveDevice).toHaveBeenCalledWith("d1");
  expect(useRelay.getState().account?.devices).toEqual([]);
});
