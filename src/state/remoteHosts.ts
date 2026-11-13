import { create } from "zustand";
import {
  type HostLink,
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
import { mayType } from "../remote/remoteScreen.ts";

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
  /** Stop showing a session here; it keeps running there. */
  close: (hostId: string, sessionId: string) => Promise<void>;
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
  pair: (invite: string) => Promise<void>;
  pairing: HostPairing;
  /** A pairing started here ended (`remote-host-pairing-ended`). */
  pairingEnded: (ended: HostPairingEnded) => Promise<void>;
  resetPairing: () => void;
  takeControl: (hostId: string, sessionId: string) => Promise<void>;
  type: (hostId: string, sessionId: string, text: string) => Promise<void>;
}

export const useRemoteHosts = create<RemoteHostsStore>((set, get) => {
  // Rust keeps one stream per session and an open replaces it, so a close
  // sent after a newer open would end the newer stream. Each session's opens
  // and closes go to Rust one at a time, in the order asked.
  const queues = new Map<string, Promise<void>>();
  function inTurn(
    hostId: string,
    sessionId: string,
    step: () => Promise<void>
  ) {
    const key = `${hostId}:${sessionId}`;
    const turn = (queues.get(key) ?? Promise.resolve()).then(step);
    queues.set(key, turn);
    turn.then(() => {
      if (queues.get(key) === turn) {
        queues.delete(key);
      }
    });
    return turn;
  }

  async function attempt(step: () => Promise<void>): Promise<void> {
    try {
      await step();
      set({ error: null });
    } catch (error) {
      set({ error: failureMessage(error) });
    }
  }

  return {
    close: (hostId, sessionId) =>
      inTurn(hostId, sessionId, () =>
        attempt(() => remoteHostCloseSession(hostId, sessionId))
      ),
    error: null,
    forget: (hostId) =>
      attempt(async () => {
        await remoteHostForget(hostId);
        const { [hostId]: _gone, ...links } = get().links;
        set({ hosts: await remoteHosts(), links });
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
      inTurn(hostId, sessionId, () =>
        attempt(() => remoteHostOpenSession(hostId, sessionId, onFrame))
      ),
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

/**
 * How many sessions on other computers need you: only on computers still
 * paired and connected, since nothing else can be acted on from here.
 */
export function remoteNeedsYouCount(state: {
  hosts: PairedHost[];
  links: Record<string, HostLink>;
}): number {
  return state.hosts.reduce((count, host) => {
    const link = state.links[host.hostId];
    if (link?.state !== "connected") {
      return count;
    }
    return count + link.sessions.filter((session) => session.needsYou).length;
  }, 0);
}

/** Whether this computer may type into `session` now. */
export function canType(link: HostLink, session: HostSession): boolean {
  return mayType(link.state, link.role, session.mine);
}
