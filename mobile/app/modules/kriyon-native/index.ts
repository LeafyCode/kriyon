/**
 * Kriyon's Rust library for the phone (crates/kriyon-mobile), through the
 * native module `KriyonNative`. Types mirror the Rust records field for
 * field; the module adds nothing of its own.
 */
import { type EventSubscription, requireNativeModule } from "expo";
import type { HostSummary } from "../../../../src/remote/hostSummary.ts";
import type { ReadableSummary } from "../../../../src/remote/readableSummary.ts";

/** A paired computer as kept (Rust `PairedHost`). */
export interface PairedHost {
  addrs: string[];
  hostId: string;
  name: string;
  pairedAtMs: number;
  relayUrl: string | null;
}

/** A relay sign-in in progress (Rust `RelaySignIn`). */
export interface RelaySignIn {
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string;
}

/** Our relay as the phone shows it (Rust `PhoneRelay`). */
export interface PhoneRelay {
  /** Whether this build has a relay at all; none: it is hidden. */
  available: boolean;
  on: boolean;
  passExpiresAt: number | null;
  /** What went wrong last, in the relay contract's words. */
  problem: string | null;
  signedIn: boolean;
  signIn: RelaySignIn | null;
}

/** The relay account, status only (Rust `RelayAccount`). */
export interface RelayAccount {
  blocked: boolean;
  deviceLimit: number;
  devices: {
    deviceId: string;
    name: string;
    platform: string;
    thisPhone: boolean;
  }[];
  paidUntil: string | null;
  /** `pending | active | past_due | canceled | expired`; null: never subscribed. */
  state: string | null;
}

/** One frame of an open session's screen, as the desktop reads them. */
export interface ScreenFrameEvent {
  frame: Uint8Array;
  hostId: string;
  sessionId: string;
}

/** An open session's readable view, whole, each time it changes. */
export interface EntriesChangedEvent {
  hostId: string;
  sessionId: string;
  summary: ReadableSummary;
}

/**
 * A Rust refusal's kind, the `code` of the error a call rejects with
 * (Rust `MobileError`), plus the module's own two.
 */
export type KriyonErrorCode =
  | "Store"
  | "Invalid"
  | "NotConnected"
  | "NotOpen"
  | "NoControl"
  | "NoScreen"
  | "Link"
  | "Refused"
  | "NotStarted"
  | "NoPairing";

/** The module's events, by name. */
interface KriyonNativeEvents {
  onEntriesChanged: (event: EntriesChangedEvent) => void;
  onHostChanged: (summary: HostSummary) => void;
  onScreenFrame: (frame: ScreenFrameEvent) => void;
}

interface KriyonNativeModule {
  addListener: <E extends keyof KriyonNativeEvents>(
    event: E,
    listener: KriyonNativeEvents[E]
  ) => EventSubscription;
  /** Stops the pairing in progress; the phone keeps nothing of it. */
  cancelPairing: () => Promise<void>;
  closeSession: (hostId: string, sessionId: string) => Promise<void>;
  finishPairing: () => Promise<PairedHost>;
  forget: (hostId: string) => Promise<void>;
  /**
   * Whether this build can get a push token at all: always on iPhone
   * (Apple's service is the system's); on Android, whether it was built
   * with a Firebase file.
   */
  hasPushService: () => boolean;
  hosts: () => Promise<PairedHost[]>;
  input: (
    hostId: string,
    sessionId: string,
    bytes: Uint8Array
  ) => Promise<void>;
  /**
   * Opens a session here for its readable-view entries only: no screen
   * crosses the link until `setScreen`. It stays open until closed.
   */
  openSession: (hostId: string, sessionId: string) => Promise<void>;
  /** Starts pairing; resolves to the code to type into the computer. */
  pair: (inviteText: string) => Promise<string>;
  /**
   * Reads a session opened here as readable-view entries too, as
   * `onEntriesChanged` events, until stopped or closed.
   */
  readEntries: (hostId: string, sessionId: string) => Promise<void>;
  /** Our relay as it stands. */
  relay: () => Promise<PhoneRelay>;
  /** The relay account's subscription and devices: status only. */
  relayAccount: () => Promise<RelayAccount>;
  relayCancelSignIn: () => Promise<void>;
  /** Turns our relay on (this phone's pass is fetched) or off. */
  relaySetOn: (on: boolean) => Promise<PhoneRelay>;
  /** Starts a device sign-in: the code to show and the page to open. */
  relaySignIn: () => Promise<RelaySignIn>;
  relaySignOut: () => Promise<PhoneRelay>;
  /** Waits for the sign-in started last; whether it signed in. */
  relayWaitSignIn: () => Promise<boolean>;
  /**
   * Gives Rust this phone's raw push token (`apns` or `fcm`); each paired
   * computer gets it sealed for itself. Resolves to whether push is on (a
   * build without a push sender keeps nothing).
   */
  setPushToken: (token: string, platform: "apns" | "fcm") => Promise<boolean>;
  /**
   * Turns an open session's screen on (its frames as `onScreenFrame`
   * events, from a fresh one) or off; the session stays open.
   */
  setScreen: (hostId: string, sessionId: string, on: boolean) => Promise<void>;
  /**
   * Starts the device side, once per run (a later call returns the same
   * device, under its first name); resolves to this phone's id.
   */
  start: (deviceName: string) => Promise<string>;
  /**
   * Starts a session in a project on a computer, titled `title` or after
   * the project; resolves to its id once the computer answers. A refusal
   * rejects with code `Refused` and the words to show.
   */
  startSession: (
    hostId: string,
    projectId: string,
    title: string | null
  ) => Promise<string>;
  /** Stops reading a session as entries. */
  stopEntries: (hostId: string, sessionId: string) => Promise<void>;
  takeControl: (hostId: string, sessionId: string) => Promise<void>;
  wake: () => void;
}

export const KriyonNative =
  requireNativeModule<KriyonNativeModule>("KriyonNative");
