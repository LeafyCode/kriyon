import { create } from "zustand";
import type { ThemeColors } from "../../../../src/theme/themes/types.ts";
import {
  type HostSession,
  type HostState,
  KriyonNative,
  type PairedHost,
} from "../../modules/kriyon-native/index.ts";

/** Which screen shows. */
export type Screen =
  | { kind: "home" }
  | { kind: "pair" }
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
  deviceId: string | null;
  forget: (hostId: string) => Promise<void>;
  hostChanged: (state: HostState) => void;
  hosts: PairedHost[];
  pair: (inviteText: string) => Promise<void>;
  pairing: Pairing;
  screen: Screen;
  show: (screen: Screen) => void;
  start: (deviceName: string) => Promise<void>;
  startError: string | null;
  states: Record<string, HostState>;
}

/** Words for a failure, from whatever was thrown. */
function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The phone app's copy of what Rust reports: this phone's id, its paired
 * computers and each one's latest state, the pairing in progress, and which
 * screen shows. Rust keeps the computers and decides; this keeps what it
 * said.
 */
export const usePhone = create<PhoneStore>((set) => ({
  cancelPairing: async () => {
    set({ pairing: { phase: "idle" } });
    await KriyonNative.cancelPairing().catch(() => undefined);
  },
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
  pair: async (inviteText) => {
    const text = inviteText.trim();
    if (text === "") {
      set({
        pairing: {
          phase: "failed",
          reason: "Paste the pairing code from the computer first.",
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
  screen: { kind: "home" },
  show: (screen) => set({ screen }),
  start: async (deviceName) => {
    try {
      const deviceId = await KriyonNative.start(deviceName);
      set({ deviceId, hosts: await KriyonNative.hosts(), startError: null });
    } catch (error) {
      set({ startError: reasonOf(error) });
    }
  },
  startError: null,
  states: {},
}));

/** One session that needs you, with its computer. */
export interface NeedsYou {
  host: PairedHost;
  session: HostSession;
}

/**
 * Sessions that need you, newest first: only on computers still paired and
 * connected, since nothing else can be acted on from here.
 */
export function needsYou(
  hosts: PairedHost[],
  states: Record<string, HostState>
): NeedsYou[] {
  return hosts
    .flatMap((host) => {
      const state = states[host.hostId];
      if (state?.link !== "connected") {
        return [];
      }
      return state.sessions
        .filter((session) => session.needsYou)
        .map((session) => ({ host, session }));
    })
    .sort((a, b) => b.session.lastChangeMs - a.session.lastChangeMs);
}

/**
 * A standing's label and dot colour, in the desktop's words (its
 * `standingMeta`) and the theme's status colours. Anything unknown reads as
 * Unknown, never as Idle.
 */
export function standingMeta(
  standing: string,
  colors: ThemeColors
): { color: string; label: string } {
  switch (standing) {
    case "running":
      return { color: colors.statusRunning, label: "Running" };
    case "awaiting_input":
      return { color: colors.statusWaiting, label: "Awaiting input" };
    case "changed":
      return { color: colors.statusDone, label: "Changed" };
    case "idle":
      return { color: colors.statusIdle, label: "Idle" };
    default:
      return { color: colors.inkFaint, label: "Unknown" };
  }
}
