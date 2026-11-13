import { create } from "zustand";
import {
  type QrGrid,
  type RemoteCodeResult,
  type RemoteDevice,
  type RemoteRole,
  type RemoteStatus,
  remoteDevices,
  remoteEnterCode,
  remotePairingQr,
  remoteRemoveDevice,
  remoteRenameDevice,
  remoteSetDeviceRole,
  remoteSetEnabled,
  remoteStartPairing,
  remoteStatus,
  remoteStopPairing,
} from "../ipc/bridge.ts";
import { failureMessage } from "../ipc/failures.ts";

/**
 * The frontend's copy of [Remote access] (ADR 0057). Rust keeps the switch,
 * the pairing and the paired devices, and checks every argument; this holds
 * what it reported, whether the consent screen is open, and the last code
 * typed.
 */
interface RemoteStore {
  /** The switch was flipped on: show the consent screen first. */
  askToTurnOn: () => void;
  cancelConsent: () => void;
  /** Why the code typed wasn't sent, if it wasn't. */
  codeError: string | null;
  /** What the last code typed did. */
  codeResult: RemoteCodeResult | null;
  consentOpen: boolean;
  devices: RemoteDevice[];
  enterCode: (code: string) => Promise<void>;
  /** Why the last command failed, if it did. */
  error: string | null;
  load: () => Promise<void>;
  /** The pairing's QR code while one is shown. */
  qr: QrGrid | null;
  /** Re-read the switch and the pairing, as after `remote-pairing-code-wanted`. */
  refresh: () => Promise<void>;
  remove: (id: string) => Promise<void>;
  rename: (id: string, name: string) => Promise<void>;
  setRole: (id: string, role: RemoteRole) => Promise<void>;
  startPairing: (role: RemoteRole) => Promise<void>;
  status: RemoteStatus | null;
  stopPairing: () => Promise<void>;
  turnOff: () => Promise<void>;
  /** "Turn on" on the consent screen. */
  turnOn: () => Promise<void>;
}

const SIX_DIGITS = /^\d{6}$/;

export const useRemote = create<RemoteStore>((set, get) => {
  /** Run `step`, keeping its failure as the store's error. */
  async function attempt(step: () => Promise<void>): Promise<void> {
    try {
      await step();
      set({ error: null });
    } catch (error) {
      set({ error: failureMessage(error) });
    }
  }

  async function reloadDevices(): Promise<void> {
    set({ devices: await remoteDevices() });
  }

  return {
    askToTurnOn: () => set({ consentOpen: true, error: null }),
    cancelConsent: () => set({ consentOpen: false }),
    codeError: null,
    codeResult: null,
    consentOpen: false,
    devices: [],
    enterCode: async (code) => {
      if (!SIX_DIGITS.test(code)) {
        set({ codeError: "The code is six digits." });
        return;
      }
      set({ codeError: null });
      await attempt(async () => {
        const result = await remoteEnterCode(code);
        set({ codeResult: result });
        if (result.outcome === "paired") {
          set({ qr: null });
          await reloadDevices();
        }
        set({ status: await remoteStatus() });
      });
    },
    error: null,
    load: () =>
      attempt(async () => {
        const [status, devices] = await Promise.all([
          remoteStatus(),
          remoteDevices(),
        ]);
        set({ devices, status });
      }),
    qr: null,
    refresh: () =>
      attempt(async () => {
        set({ status: await remoteStatus() });
      }),
    remove: (id) =>
      attempt(async () => {
        await remoteRemoveDevice(id);
        await reloadDevices();
      }),
    rename: (id, name) =>
      attempt(async () => {
        await remoteRenameDevice(id, name);
        await reloadDevices();
      }),
    setRole: (id, role) =>
      attempt(async () => {
        await remoteSetDeviceRole(id, role);
        await reloadDevices();
      }),
    startPairing: (role) =>
      attempt(async () => {
        set({ codeError: null, codeResult: null });
        const text = await remoteStartPairing(role);
        set({ qr: await remotePairingQr(text) });
        set({ status: await remoteStatus() });
      }),
    status: null,
    stopPairing: () =>
      attempt(async () => {
        await remoteStopPairing();
        set({ codeError: null, codeResult: null, qr: null });
        set({ status: await remoteStatus() });
      }),
    turnOff: () =>
      attempt(async () => {
        const status = await remoteSetEnabled(false);
        set({ codeResult: null, qr: null, status });
      }),
    turnOn: async () => {
      // Only from the consent screen: nothing turns this on without it.
      if (!get().consentOpen) {
        return;
      }
      set({ consentOpen: false });
      await attempt(async () => {
        set({ status: await remoteSetEnabled(true) });
      });
    },
  };
});

/**
 * What the consent screen says before remote access turns on: what changes,
 * in plain words, and only what is true today (ADR 0057).
 */
export const CONSENT_LINES: readonly string[] = [
  "Devices you pair can see your sessions, and Controllers can type into them.",
  "A Controller can do anything you can do in a terminal: full shell access as you.",
  "A Viewer sees every session's screen, including any secret printed there.",
  "This computer starts accepting connections, from paired devices only.",
  "Devices reach this computer directly, on the same network or through your own Tailscale. Everything between them is end-to-end encrypted.",
  "A paired phone that's lost or stolen can still reach your sessions until you remove it here.",
];

/** "4:59": time left until `expiresAtMs`, never below zero. */
export function countdownText(expiresAtMs: number, nowMs: number): string {
  const seconds = Math.max(0, Math.ceil((expiresAtMs - nowMs) / 1000));
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${minutes}:${String(rest).padStart(2, "0")}`;
}

/** The line shown under the code field after a code was typed. */
export function codeResultLine(result: RemoteCodeResult): string {
  switch (result.outcome) {
    case "paired":
      return `${result.name} is paired.`;
    case "wrong":
      return `That code is wrong. ${result.triesLeft} ${
        result.triesLeft === 1 ? "try" : "tries"
      } left.`;
    case "burned":
      return "Too many wrong codes. Start again with a new QR code.";
    default:
      return "No device is waiting for a code. Start again with a new QR code.";
  }
}
