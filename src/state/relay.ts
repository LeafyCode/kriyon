import { create } from "zustand";
import {
  type RelayAccount,
  type RelayView,
  relayAccount,
  relayCancelSignIn,
  relayOpenSubscriptions,
  relayRemoveDevice,
  relaySetEnabled,
  relaySignIn,
  relaySignOut,
  relayThisDevice,
  relayView,
} from "../ipc/bridge.ts";
import { failureMessage } from "../ipc/failures.ts";
import { subscriptionWords } from "../remote/relayWords.ts";
import { CONSENT_LINES } from "./remote.ts";

/**
 * The frontend's copy of our relay (the relay pass contract). Rust signs in,
 * keeps the pass and decides; this holds what it reported and the last
 * error, in the contract's words.
 */
interface RelayStore {
  /** The relay account's subscription and devices, while signed in. */
  account: RelayAccount | null;
  cancelSignIn: () => Promise<void>;
  /** Why the last command failed, if it did. */
  error: string | null;
  /** Read the relay, and the account when signed in. */
  load: () => Promise<void>;
  /** Open the website's subscriptions page. */
  openSubscriptions: () => Promise<void>;
  removeDevice: (deviceId: string) => Promise<void>;
  setOn: (on: boolean) => Promise<void>;
  /** Start a device sign-in; Rust opens the page and tells when it ends. */
  signIn: () => Promise<void>;
  signOut: () => Promise<void>;
  /** This computer's device key, to mark it in the account's devices. */
  thisDeviceKey: string | null;
  view: RelayView | null;
}

export const useRelay = create<RelayStore>((set) => {
  /** Run `step`, keeping its failure as the store's error. */
  async function attempt(step: () => Promise<void>): Promise<void> {
    try {
      await step();
      set({ error: null });
    } catch (error) {
      set({ error: failureMessage(error) });
    }
  }

  async function readAccount(): Promise<void> {
    const [account, me] = await Promise.all([
      relayAccount(),
      relayThisDevice(),
    ]);
    set({ account, thisDeviceKey: me.deviceKey });
  }

  return {
    account: null,
    cancelSignIn: () =>
      attempt(async () => {
        await relayCancelSignIn();
        set({ view: await relayView() });
      }),
    error: null,
    load: () =>
      attempt(async () => {
        const view = await relayView();
        // Never shown from before: only what this read gives.
        set({ account: null, view });
        if (view.available && view.signedIn) {
          await readAccount();
        }
      }),
    openSubscriptions: () => attempt(() => relayOpenSubscriptions()),
    removeDevice: (deviceId) =>
      attempt(async () => {
        await relayRemoveDevice(deviceId);
        set({ account: await relayAccount() });
      }),
    setOn: (on) =>
      attempt(async () => {
        const view = await relaySetEnabled(on);
        set({ view });
        // Turning on registers this device on the account.
        if (view.signedIn) {
          await readAccount();
        }
      }),
    signIn: () =>
      attempt(async () => {
        await relaySignIn();
        set({ view: await relayView() });
      }),
    signOut: () =>
      attempt(async () => {
        set({ account: null, view: await relaySignOut() });
      }),
    thisDeviceKey: null,
    view: null,
  };
});

/** Said on the consent screen while our relay is on. */
export const RELAY_CONSENT_LINE =
  "Through our relay, traffic passes a server that can't read it. It only joins devices signed in to the same relay account.";

/** What the consent screen says: the relay's line only while it is on. */
export function consentLines(relayOn: boolean): readonly string[] {
  return relayOn ? [...CONSENT_LINES, RELAY_CONSENT_LINE] : CONSENT_LINES;
}

/** Both computers need the same account, or the relay can't join them. */
export const SAME_ACCOUNT_NOTE =
  "Sign in with the same account on both computers: our relay only joins devices of one account.";

/** The subscription's state, in plain words. */
export function subscriptionLine(account: RelayAccount): string {
  return subscriptionWords({
    blocked: account.blocked,
    paidUntil: account.subscription?.paidUntil ?? null,
    state: account.subscription?.state ?? null,
  });
}

/** The website button: subscribe while there is nothing to manage. */
export function subscribeLabel(account: RelayAccount | null): string {
  const state = account?.subscription?.state;
  return state === undefined || state === "expired"
    ? "Subscribe"
    : "Manage subscription";
}
