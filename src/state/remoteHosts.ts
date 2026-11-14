import { create } from "zustand";
import {
  type HostPairingEnded,
  onRemoteHostChanged,
  onRemoteHostPairingEnded,
  type PairedHost,
  type RemoteScreen,
  remoteHostForget,
  remoteHostInput,
  remoteHostPair,
  remoteHostSetView,
  remoteHostStartSession,
  remoteHosts,
  remoteHostsWake,
  remoteHostTakeControl,
} from "../ipc/bridge.ts";
import { failureMessage } from "../ipc/failures.ts";
import { onEvent, stopAll } from "../ipc/onEvent.ts";
import { type HostSummary, needsYouCount } from "../remote/hostSummary.ts";
import type { ReadableSummary } from "../remote/readableSummary.ts";

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
  /** A new start is being asked for there: the last refusal no longer stands. */
  clearStartError: (hostId: string) => void;
  /** Stop showing a session here; it keeps running there. */
  close: (hostId: string, sessionId: string) => Promise<void>;
  /** Why the last command failed, if it did. */
  error: string | null;
  forget: (hostId: string) => Promise<void>;
  /** Stop showing its screen; the session stays open. */
  hideScreen: (hostId: string, sessionId: string) => Promise<void>;
  hosts: PairedHost[];
  /** A paired computer's link changed (`remote-host-changed`). */
  linkChanged: (link: HostSummary) => void;
  links: Record<string, HostSummary>;
  load: () => Promise<void>;
  /** Open a session here (its entries; its screen with `showScreen`); it
   *  stays open, whichever is shown, until `close`. */
  open: (hostId: string, sessionId: string) => Promise<void>;
  pair: (invite: string) => Promise<void>;
  pairing: HostPairing;
  /** A pairing started here ended (`remote-host-pairing-ended`). */
  pairingEnded: (ended: HostPairingEnded) => Promise<void>;
  /** Sessions read here as entries, by `host:session`: what Rust last sent. */
  readable: Record<string, ReadableSummary>;
  /** Read an open session as entries too, after its open. */
  readEntries: (hostId: string, sessionId: string) => Promise<void>;
  resetPairing: () => void;
  /** Show an open session's screen: its frames come to `onFrame`. */
  showScreen: (
    hostId: string,
    sessionId: string,
    onFrame: (frame: Uint8Array) => void
  ) => Promise<void>;
  /** Why the last start on each computer was refused, in its words. */
  startErrors: Record<string, string>;
  /** The session a start made, for the view to open; taken once. */
  started: { hostId: string; sessionId: string } | null;
  /** Computers a start is under way on. */
  starting: Record<string, boolean>;
  /**
   * Start a session there: its id, also kept in `started`; or `null`, with
   * `startErrors[hostId]` saying why.
   */
  startSession: (
    hostId: string,
    projectId: string,
    title: string
  ) => Promise<string | null>;
  /** Stop reading it as entries; forget what was read. */
  stopEntries: (hostId: string, sessionId: string) => Promise<void>;
  takeControl: (hostId: string, sessionId: string) => Promise<void>;
  takeStarted: () => void;
  type: (hostId: string, sessionId: string, text: string) => Promise<void>;
  /** Each session's view as last asked of Rust, by `host:session`. */
  views: Record<string, SessionView>;
}

/** How a session is shown here: its screen's frames, its entries read. */
interface SessionView {
  entries: boolean;
  onFrame: ((frame: Uint8Array) => void) | null;
}

/** The screen to ask Rust for: fresh when this change shows one, kept when
 *  it changes something else with one on, else off. */
function screenAsked(
  onFrame: SessionView["onFrame"],
  changed: SessionView["onFrame"] | undefined
): RemoteScreen {
  if (!onFrame) {
    return "off";
  }
  return changed === undefined ? "kept" : { fresh: onFrame };
}

function readableKey(hostId: string, sessionId: string): string {
  return `${hostId}:${sessionId}`;
}

/** What session `sessionId` there shows read as entries, if it is read. */
export function readableOf(
  hostId: string,
  sessionId: string
): ReadableSummary | undefined {
  return useRemoteHosts.getState().readable[readableKey(hostId, sessionId)];
}

export const useRemoteHosts = create<RemoteHostsStore>((set, get) => {
  // Rust takes only a view newer than the last it took, so calls may reach
  // it in any order and nothing here waits on another. Numbered from the
  // clock (in microseconds), so a page loaded again starts above every view
  // the last one asked: Rust outlives the page.
  let viewSeq = 0;
  function nextSeq(): number {
    viewSeq = Math.max(viewSeq + 1, Date.now() * 1000);
    return viewSeq;
  }

  function onEntries(hostId: string, sessionId: string) {
    return (summary: ReadableSummary) =>
      set((state) => ({
        readable: {
          ...state.readable,
          [readableKey(hostId, sessionId)]: summary,
        },
      }));
  }

  /** Ask Rust to show a session as changed by `change`, or closed (`null`). */
  function setView(
    hostId: string,
    sessionId: string,
    change: Partial<SessionView> | null
  ): Promise<void> {
    const key = readableKey(hostId, sessionId);
    const seq = nextSeq();
    if (change === null) {
      const { [key]: _gone, ...views } = get().views;
      set({ views });
      return attempt(() => remoteHostSetView(hostId, sessionId, seq, null));
    }
    const view = {
      ...(get().views[key] ?? { entries: false, onFrame: null }),
      ...change,
    };
    set((state) => ({ views: { ...state.views, [key]: view } }));
    return attempt(() =>
      remoteHostSetView(hostId, sessionId, seq, {
        onEntries: view.entries ? onEntries(hostId, sessionId) : null,
        screen: screenAsked(view.onFrame, change.onFrame),
      })
    );
  }

  function forgetReadable(hostId: string, sessionId: string) {
    const key = readableKey(hostId, sessionId);
    if (key in get().readable) {
      const { [key]: _gone, ...readable } = get().readable;
      set({ readable });
    }
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
    close: (hostId, sessionId) => {
      forgetReadable(hostId, sessionId);
      return setView(hostId, sessionId, null);
    },
    error: null,
    forget: (hostId) =>
      attempt(async () => {
        await remoteHostForget(hostId);
        const { [hostId]: _gone, ...links } = get().links;
        // Its sessions' views go with it: nothing is shown from there now.
        const views = Object.fromEntries(
          Object.entries(get().views).filter(
            ([key]) => !key.startsWith(`${hostId}:`)
          )
        );
        set({ hosts: await remoteHosts(), links, views });
      }),
    hosts: [],
    linkChanged: (link) =>
      set((state) => ({ links: { ...state.links, [link.hostId]: link } })),
    links: {},
    load: () =>
      attempt(async () => {
        set({ hosts: await remoteHosts() });
      }),
    // A screen goes with its session: hiding one that just closed (the view
    // closes it as the terminal unmounts) asks nothing, and one Rust won't
    // take (its computer forgotten meanwhile) is no failure.
    hideScreen: async (hostId, sessionId) => {
      const key = readableKey(hostId, sessionId);
      const view = get().views[key];
      if (!view) {
        return;
      }
      const quiet = { ...view, onFrame: null };
      set((state) => ({ views: { ...state.views, [key]: quiet } }));
      try {
        await remoteHostSetView(hostId, sessionId, nextSeq(), {
          onEntries: quiet.entries ? onEntries(hostId, sessionId) : null,
          screen: "off",
        });
      } catch {
        // Quiet, as above.
      }
    },
    open: (hostId, sessionId) => setView(hostId, sessionId, {}),
    showScreen: (hostId, sessionId, onFrame) =>
      setView(hostId, sessionId, { onFrame }),
    readable: {},
    views: {},
    readEntries: (hostId, sessionId) =>
      setView(hostId, sessionId, { entries: true }),
    stopEntries: (hostId, sessionId) => {
      forgetReadable(hostId, sessionId);
      return setView(hostId, sessionId, { entries: false });
    },
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
    clearStartError: (hostId) =>
      set((state) => {
        const { [hostId]: _gone, ...startErrors } = state.startErrors;
        return { startErrors };
      }),
    startErrors: {},
    startSession: async (hostId, projectId, title) => {
      set((state) => ({ starting: { ...state.starting, [hostId]: true } }));
      const settle = (change: Partial<RemoteHostsStore>) =>
        set((state) => {
          const { [hostId]: _done, ...starting } = state.starting;
          return { ...change, starting };
        });
      try {
        const sessionId = await remoteHostStartSession(
          hostId,
          projectId,
          title
        );
        settle({ started: { hostId, sessionId } });
        get().clearStartError(hostId);
        return sessionId;
      } catch (error) {
        settle({
          startErrors: {
            ...get().startErrors,
            [hostId]: failureMessage(error),
          },
        });
        return null;
      }
    },
    started: null,
    starting: {},
    takeStarted: () => set({ started: null }),
    takeControl: (hostId, sessionId) =>
      attempt(() => remoteHostTakeControl(hostId, sessionId)),
    type: async (hostId, sessionId, text) => {
      const link = get().links[hostId];
      const session = link?.sessions.find((one) => one.id === sessionId);
      // Typing reaches the other computer only with control; Rust checks too.
      if (!session?.mayType) {
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
  links: Record<string, HostSummary>;
}): number {
  return needsYouCount(state.hosts, state.links);
}
