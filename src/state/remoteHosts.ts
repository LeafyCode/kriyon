import { create } from "zustand";
import {
  type HostLink,
  type HostLinkState,
  type HostPairingEnded,
  type HostSession,
  onRemoteHostChanged,
  onRemoteHostPairingEnded,
  type PairedHost,
  remoteHostCloseSession,
  remoteHostForget,
  remoteHostInput,
  remoteHostOpenSession,
  remoteHostPair,
  remoteHosts,
  remoteHostsWake,
  remoteHostTakeControl,
} from "../ipc/bridge.ts";
import { failureMessage } from "../ipc/failures.ts";
import { onEvent, stopAll } from "../ipc/onEvent.ts";

/**
 * This computer as a [Remote device] of other computers (plan Step D). Rust
 * pairs, stays connected and streams; this holds what it reported: the
 * paired computers, each one's link and sessions, a pairing in progress and
 * the session open here.
 */

/** A pairing with another computer, started here. */
export type HostPairing =
  | { phase: "idle" }
  | { phase: "working" }
  /** Type this code into the other computer. */
  | { code: string; phase: "code" }
  | { name: string; phase: "paired" }
  | { phase: "failed"; reason: string };

interface RemoteHostsStore {
  close: () => Promise<void>;
  /** Why the last command failed, if it did. */
  error: string | null;
  forget: (hostId: string) => Promise<void>;
  hosts: PairedHost[];
  /** A paired computer's link changed (`remote-host-changed`). */
  linkChanged: (link: HostLink) => void;
  links: Record<string, HostLink>;
  load: () => Promise<void>;
  open: (
    hostId: string,
    sessionId: string,
    onFrame: (frame: Uint8Array) => void
  ) => Promise<void>;
  /** The session shown here, if any. */
  opened: { hostId: string; sessionId: string } | null;
  pair: (invite: string) => Promise<void>;
  pairing: HostPairing;
  /** A pairing started here ended (`remote-host-pairing-ended`). */
  pairingEnded: (ended: HostPairingEnded) => Promise<void>;
  resetPairing: () => void;
  takeControl: (hostId: string, sessionId: string) => Promise<void>;
  type: (hostId: string, sessionId: string, text: string) => Promise<void>;
}

export const useRemoteHosts = create<RemoteHostsStore>((set, get) => {
  async function attempt(step: () => Promise<void>): Promise<void> {
    try {
      await step();
      set({ error: null });
    } catch (error) {
      set({ error: failureMessage(error) });
    }
  }

  return {
    close: async () => {
      const { opened } = get();
      if (!opened) {
        return;
      }
      set({ opened: null });
      await attempt(() =>
        remoteHostCloseSession(opened.hostId, opened.sessionId)
      );
    },
    error: null,
    forget: (hostId) =>
      attempt(async () => {
        await remoteHostForget(hostId);
        const { [hostId]: _gone, ...links } = get().links;
        set({ hosts: await remoteHosts(), links });
        if (get().opened?.hostId === hostId) {
          set({ opened: null });
        }
      }),
    hosts: [],
    linkChanged: (link) =>
      set((state) => ({ links: { ...state.links, [link.hostId]: link } })),
    links: {},
    load: () =>
      attempt(async () => {
        set({ hosts: await remoteHosts() });
      }),
    open: (hostId, sessionId, onFrame) =>
      attempt(async () => {
        await remoteHostOpenSession(hostId, sessionId, onFrame);
        set({ opened: { hostId, sessionId } });
      }),
    opened: null,
    pair: async (invite) => {
      const text = invite.trim();
      if (text === "") {
        set({
          pairing: {
            phase: "failed",
            reason: "Paste the pairing code from the other computer.",
          },
        });
        return;
      }
      set({ pairing: { phase: "working" } });
      try {
        const code = await remoteHostPair(text);
        set({ pairing: { code, phase: "code" } });
      } catch (error) {
        set({ pairing: { phase: "failed", reason: failureMessage(error) } });
      }
    },
    pairing: { phase: "idle" },
    pairingEnded: async (ended) => {
      if (ended.outcome === "failed") {
        set({ pairing: { phase: "failed", reason: ended.reason } });
        return;
      }
      set({ pairing: { name: ended.name, phase: "paired" } });
      await get().load();
    },
    resetPairing: () => set({ pairing: { phase: "idle" } }),
    takeControl: (hostId, sessionId) =>
      attempt(() => remoteHostTakeControl(hostId, sessionId)),
    type: async (hostId, sessionId, text) => {
      const link = get().links[hostId];
      const session = link?.sessions.find((one) => one.id === sessionId);
      // Typing reaches the other computer only with control; Rust checks too.
      if (!(link && session && canType(link, session))) {
        return;
      }
      await attempt(() => remoteHostInput(hostId, sessionId, text));
    },
  };
});

/**
 * Follow the paired computers: load them, keep each link as Rust reports it,
 * hear how a pairing ended, and retry waiting reconnects when the window
 * comes back to the front. Returns one cleanup.
 */
export function installRemoteHostListeners(): () => void {
  const store = () => useRemoteHosts.getState();
  store()
    .load()
    .catch(() => undefined);
  const wake = () => {
    remoteHostsWake().catch(() => undefined);
  };
  window.addEventListener("focus", wake);
  const stop = stopAll([
    onEvent(onRemoteHostChanged, (link) => store().linkChanged(link)),
    onEvent(onRemoteHostPairingEnded, (ended) => {
      store()
        .pairingEnded(ended)
        .catch(() => undefined);
    }),
  ]);
  return () => {
    window.removeEventListener("focus", wake);
    stop();
  };
}

/** What one raw screen frame from Rust says (see `screen_frame` in Rust). */
export type ScreenFrame =
  | { bytes: Uint8Array; kind: "output" }
  | {
      bytes: Uint8Array;
      cols: number;
      kind: "screen";
      rows: number;
      skipped: boolean;
    }
  | { kind: "receipt"; written: boolean }
  | { kind: "refused"; reason: number };

/** Read one frame: a kind byte, then its fields. `null` for anything else. */
export function decodeScreenFrame(frame: Uint8Array): ScreenFrame | null {
  const [kind] = frame;
  switch (kind) {
    case 0:
      return { bytes: frame.subarray(1), kind: "output" };
    case 1: {
      if (frame.length < 6) {
        return null;
      }
      const view = new DataView(frame.buffer, frame.byteOffset, frame.length);
      return {
        bytes: frame.subarray(6),
        cols: view.getUint16(1),
        kind: "screen",
        rows: view.getUint16(3),
        skipped: frame[5] === 1,
      };
    }
    case 2:
      return frame.length === 2
        ? { kind: "receipt", written: frame[1] === 1 }
        : null;
    case 3:
      return frame.length === 2 ? { kind: "refused", reason: frame[1] } : null;
    default:
      return null;
  }
}

/** Whether this computer may type into `session` now. */
export function canType(link: HostLink, session: HostSession): boolean {
  return (
    link.state === "connected" && link.role === "controller" && session.mine
  );
}

/** The line that says where a paired computer's link stands. */
export function linkLine(state: HostLinkState): string {
  switch (state) {
    case "lost":
      return "Disconnected, reconnecting. Typing is off.";
    case "removed":
      return "Removed from that computer. Pair again to use it.";
    case "connecting":
      return "Connecting…";
    default:
      return "Connected";
  }
}
