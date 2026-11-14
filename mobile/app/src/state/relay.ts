/**
 * Our relay on the phone, as Rust reports it: device sign-in in the phone's
 * browser, the relay on or off, and the account's status. The phone has no
 * buy button (Apple's rules): subscriptions are managed on the computer.
 */
import { Linking } from "react-native";
import { create } from "zustand";
import {
  KriyonNative,
  type PhoneRelay,
  type RelayAccount,
} from "../../modules/kriyon-native/index.ts";

interface RelayStore {
  account: RelayAccount | null;
  /** Stop the sign-in in progress. */
  cancelSignIn: () => Promise<void>;
  /** Why the last call failed, in Rust's words. */
  error: string | null;
  /** Read the relay, and the account while signed in. */
  load: () => Promise<void>;
  setOn: (on: boolean) => Promise<void>;
  /** Start a device sign-in: show the code, open the page, wait. */
  signIn: () => Promise<void>;
  signOut: () => Promise<void>;
  view: PhoneRelay | null;
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export const useRelay = create<RelayStore>((set, get) => {
  /** Read the account again while signed in; the old one stays until then. */
  async function readAccount(): Promise<void> {
    if (get().view?.signedIn) {
      set({ account: await KriyonNative.relayAccount() });
    } else {
      set({ account: null });
    }
  }

  async function attempt(step: () => Promise<void>): Promise<void> {
    try {
      await step();
      set({ error: null });
    } catch (error) {
      set({ error: reasonOf(error) });
    }
  }

  return {
    account: null,
    cancelSignIn: () =>
      attempt(async () => {
        await KriyonNative.relayCancelSignIn();
        set({ view: await KriyonNative.relay() });
      }),
    error: null,
    load: () =>
      attempt(async () => {
        set({ view: await KriyonNative.relay() });
        await readAccount();
      }),
    setOn: (on) =>
      attempt(async () => {
        set({ view: await KriyonNative.relaySetOn(on) });
        // Turning on registers this phone on the account.
        await readAccount();
      }),
    signIn: () =>
      attempt(async () => {
        const signIn = await KriyonNative.relaySignIn();
        const { view } = get();
        if (view) {
          set({ view: { ...view, signIn } });
        }
        await Linking.openURL(signIn.verificationUriComplete).catch(
          () => undefined
        );
        await KriyonNative.relayWaitSignIn();
        await get().load();
      }),
    signOut: () =>
      attempt(async () => {
        set({ account: null, view: await KriyonNative.relaySignOut() });
      }),
    view: null,
  };
});
