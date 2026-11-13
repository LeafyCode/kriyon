import { create } from "zustand";
import {
  type HostSummary,
  pairingCodeFrom,
  standingLabel,
} from "../../../../src/remote/hostSummary.ts";
import type { ThemeColors } from "../../../../src/theme/themes/types.ts";
import type { StandingState } from "../../../../src/types.ts";
import {
  KriyonNative,
  type PairedHost,
} from "../../modules/kriyon-native/index.ts";
import { type PushStatus, registerPush } from "./push.ts";

/** Which screen shows. */
export type Screen =
  | { kind: "home" }
  | { kind: "pair" }
  | { hostId: string; kind: "new" }
  | { hostId: string; kind: "session"; sessionId: string };

/** Where a pairing started here stands. */
export type Pairing =
  | { phase: "idle" }
  | { phase: "working" }
  | { code: string; phase: "code" }
  | { name: string; phase: "paired" }
  | { phase: "failed"; reason: string };

interface PhoneStore {
  cancelPairing: () => Promise<void>;
  /** Close a session's stream, after any open asked before it. */
  closeSession: (hostId: string, sessionId: string) => Promise<void>;
  deviceId: string | null;
  forget: (hostId: string) => Promise<void>;
  hostChanged: (state: HostSummary) => void;
  hosts: PairedHost[];
  /**
   * Start a session in `projectId` on `hostId`, titled `title` or after the
   * project; once it starts, its screen shows.
   */
  newSession: (
    hostId: string,
    projectId: string,
    title: string | null
  ) => Promise<void>;
  /** Why the last new session didn't start, in the computer's words. */
  newSessionError: string | null;
  /** A new session is being started. */
  newSessionStarting: boolean;
  /** Open a session's stream, after any open or close asked before it. */
  openSession: (hostId: string, sessionId: string) => Promise<void>;
  pair: (inviteText: string) => Promise<void>;
  pairing: Pairing;
  /** Where phone alerts stand; `null` until asked. */
  push: PushStatus | null;
  screen: Screen;
  show: (screen: Screen) => void;
  start: (deviceName: string) => Promise<void>;
  startError: string | null;
  states: Record<string, HostSummary>;
}

/** Words for a failure, from whatever was thrown. */
function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Session opens and closes run one after another, so a close never
 * overtakes the open it follows; a failed one doesn't stop the next.
 */
let sessionCalls: Promise<unknown> = Promise.resolve();

function inTurn(call: () => Promise<void>): Promise<void> {
  const turn = sessionCalls.then(call, call);
  sessionCalls = turn.catch(() => undefined);
  return turn;
}

/**
 * The phone app's copy of what Rust reports: this phone's id, its paired
 * computers and each one's latest state, the pairing in progress, and which
 * screen shows. Rust keeps the computers and decides; this keeps what it
 * said.
 */
export const usePhone = create<PhoneStore>((set, get) => ({
  cancelPairing: async () => {
    set({ pairing: { phase: "idle" } });
    await KriyonNative.cancelPairing().catch(() => undefined);
  },
  closeSession: (hostId, sessionId) =>
    inTurn(() => KriyonNative.closeSession(hostId, sessionId)),
  deviceId: null,
  forget: async (hostId) => {
    await KriyonNative.forget(hostId);
    set((state) => {
      const { [hostId]: _gone, ...states } = state.states;
      const showing =
        state.screen.kind === "session" && state.screen.hostId === hostId;
      return {
        hosts: state.hosts.filter((one) => one.hostId !== hostId),
        screen: showing ? { kind: "home" } : state.screen,
        states,
      };
    });
  },
  hostChanged: (hostState) =>
    set((state) => ({
      states: { ...state.states, [hostState.hostId]: hostState },
    })),
  hosts: [],
  newSession: async (hostId, projectId, title) => {
    // One start at a time: a second tap would start a second session.
    if (get().newSessionStarting) {
      return;
    }
    set({ newSessionError: null, newSessionStarting: true });
    try {
      // A blank title is Rust's to name after the project.
      const sessionId = await KriyonNative.startSession(
        hostId,
        projectId,
        title || null
      );
      // Only if the person is still waiting for it here.
      const { screen } = get();
      if (screen.kind === "new" && screen.hostId === hostId) {
        set({ screen: { hostId, kind: "session", sessionId } });
      }
    } catch (error) {
      set({ newSessionError: reasonOf(error) });
    } finally {
      set({ newSessionStarting: false });
    }
  },
  newSessionError: null,
  newSessionStarting: false,
  openSession: (hostId, sessionId) =>
    inTurn(() => KriyonNative.openSession(hostId, sessionId)),
  pair: async (inviteText) => {
    if (inviteText.trim() === "") {
      set({
        pairing: {
          phase: "failed",
          reason: "Paste the pairing code from the computer first.",
        },
      });
      return;
    }
    // Scanned or pasted, the same check; Rust reads the rest of it.
    const text = pairingCodeFrom(inviteText);
    if (!text) {
      set({
        pairing: {
          phase: "failed",
          reason: "That isn't a Kriyon pairing code.",
        },
      });
      return;
    }
    set({ pairing: { phase: "working" } });
    try {
      const code = await KriyonNative.pair(text);
      set({ pairing: { code, phase: "code" } });
      const host = await KriyonNative.finishPairing();
      set({
        hosts: await KriyonNative.hosts(),
        pairing: { name: host.name, phase: "paired" },
      });
    } catch (error) {
      set({ pairing: { phase: "failed", reason: reasonOf(error) } });
    }
  },
  pairing: { phase: "idle" },
  push: null,
  screen: { kind: "home" },
  show: (screen) => set({ newSessionError: null, screen }),
  start: async (deviceName) => {
    try {
      const deviceId = await KriyonNative.start(deviceName);
      set({ deviceId, hosts: await KriyonNative.hosts(), startError: null });
      // Alerts come once Rust is up: it seals the token for each computer.
      set({ push: await registerPush() });
    } catch (error) {
      set({ startError: reasonOf(error) });
    }
  },
  startError: null,
  states: {},
}));

/**
 * A standing's label and dot colour, in the desktop's words (its
 * `standingMeta`) and the theme's status colours. Anything unknown reads as
 * Unknown, never as Idle.
 */
export function standingMeta(
  standing: StandingState,
  colors: ThemeColors
): { color: string; label: string } {
  const label = standingLabel(standing);
  switch (standing) {
    case "running":
      return { color: colors.statusRunning, label };
    case "awaiting_input":
      return { color: colors.statusWaiting, label };
    case "changed":
      return { color: colors.statusDone, label };
    case "idle":
      return { color: colors.statusIdle, label };
    default:
      return { color: colors.inkFaint, label };
  }
}

/**
 * Bytes as base64, for the terminal page: a script can carry only text.
 * Built in chunks, so a big screen never overflows the call stack.
 */
export function toBase64(bytes: Uint8Array): string {
  const CHUNK = 0x80_00;
  let text = "";
  for (let at = 0; at < bytes.length; at += CHUNK) {
    text += String.fromCharCode(...bytes.subarray(at, at + CHUNK));
  }
  return btoa(text);
}
