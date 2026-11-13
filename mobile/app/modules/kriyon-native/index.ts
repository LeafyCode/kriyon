/**
 * Kriyon's Rust library for the phone (crates/kriyon-mobile), through the
 * native module `KriyonNative`. Types mirror the Rust records field for
 * field; the module adds nothing of its own.
 */
import { type EventSubscription, requireNativeModule } from "expo";

/** Where a computer's link stands (Rust `HostLink`). */
export type HostLink = "connecting" | "connected" | "lost" | "removed";

/** Who types into a session now (Rust `Typing`). */
export type Typing = "host" | "you" | "other";

/** One session on a computer (Rust `HostSession`). */
export interface HostSession {
  dialogOpen: boolean;
  id: string;
  lastChangeMs: number;
  needsYou: boolean;
  projectId: string;
  /** Named as the desktop's JSON names it (`awaiting_input`). */
  standing: string;
  /** Named as the desktop's JSON names it (`waiting`). */
  status: string;
  title: string;
  typing: Typing | null;
}

/** A computer as the phone shows it (Rust `HostState`). */
export interface HostState {
  hostId: string;
  hostName: string | null;
  link: HostLink;
  /** The last refusal the computer sent, by name (`NotInControl`). */
  refused: string | null;
  role: "viewer" | "controller" | null;
  sessions: HostSession[];
}

/** A paired computer as kept (Rust `PairedHost`). */
export interface PairedHost {
  addrs: string[];
  hostId: string;
  name: string;
  pairedAtMs: number;
  relayUrl: string | null;
}

/** One frame of an open session's screen, as the desktop reads them. */
export interface ScreenFrameEvent {
  frame: Uint8Array;
  hostId: string;
  sessionId: string;
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
  | "NotStarted"
  | "NoPairing";

/** The module's events, by name. */
interface KriyonNativeEvents {
  onHostChanged: (state: HostState) => void;
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
  hosts: () => Promise<PairedHost[]>;
  input: (
    hostId: string,
    sessionId: string,
    bytes: Uint8Array
  ) => Promise<void>;
  openSession: (hostId: string, sessionId: string) => Promise<void>;
  /** Starts pairing; resolves to the code to type into the computer. */
  pair: (inviteText: string) => Promise<string>;
  /**
   * Starts the device side, once per run (a later call returns the same
   * device, under its first name); resolves to this phone's id.
   */
  start: (deviceName: string) => Promise<string>;
  takeControl: (hostId: string, sessionId: string) => Promise<void>;
  wake: () => void;
}

export const KriyonNative =
  requireNativeModule<KriyonNativeModule>("KriyonNative");
