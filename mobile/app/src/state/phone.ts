import { create } from "zustand";
import {
  type HostSummary,
  pairingCodeFrom,
} from "../../../../src/remote/hostSummary.ts";
import type { ReadableSummary } from "../../../../src/remote/readableSummary.ts";
import {
  type EntriesChangedEvent,
  KriyonNative,
  type PairedHost,
} from "../../modules/kriyon-native/index.ts";
import { messageSteps } from "./keys.ts";
import { type PushStatus, registerPush } from "./push.ts";

/** Which screen shows. */
export type Screen =
  | { kind: "home" }
  | { kind: "pair" }
  | { kind: "settings" }
  | { hostId: string; kind: "new" }
  | {
      hostId: string;
      kind: "session";
      sessionId: string;
      /** Which view opens first; Readable unless said. */
      view?: "readable" | "terminal";
    };

/** Where a pairing started here stands. */
export type Pairing =
  | { phase: "idle" }
  | { phase: "working" }
  | {
      code: string;
      /** When the code stops working (Unix ms); not sent yet. */
      expiresAtMs?: number | null;
      phase: "code";
      /** The role the computer offered this phone; not sent yet. */
      role?: "viewer" | "controller" | null;
    }
  | { name: string; phase: "paired" }
  | { phase: "failed"; reason: string };

/** How the person wants a session shown here: its screen, its entries. */
interface View {
  entries: boolean;
  screen: boolean;
}

interface PhoneStore {
  /**
   * The phone's Back (Android's gesture or button, and the screens' own):
   * home from any screen, cancelling a pairing on the way. `false` at home,
   * so Android leaves the app.
   */
  back: () => boolean;
  cancelPairing: () => Promise<void>;
  /**
   * Close a session's readable view (and its stream): its entries go; why
   * it had none stays, so the terminal keeps saying it.
   */
  closeReadable: (hostId: string, sessionId: string) => Promise<void>;
  deviceId: string | null;
  /** A session's readable view changed in Rust: kept whole while it is read. */
  entriesChanged: (event: EntriesChangedEvent) => void;
  forget: (hostId: string) => Promise<void>;
  /** Forget a session's readable view (the person left the session). */
  forgetReadable: (hostId: string, sessionId: string) => void;
  /** Turn an open session's screen off, after what was asked before it. */
  hideScreen: (hostId: string, sessionId: string) => Promise<void>;
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
  /**
   * Open a session's stream, then read it as readable-view entries. Rejects
   * when the session can't be opened; a read that fails is shown as no
   * entries, with why.
   */
  openReadable: (hostId: string, sessionId: string) => Promise<void>;
  pair: (inviteText: string) => Promise<void>;
  pairing: Pairing;
  /** Where phone alerts stand; `null` until asked. */
  push: PushStatus | null;
  /**
   * Each session's readable view as Rust last sent it, by [`readableKey`];
   * none until its first entries come. `unavailable` words mean show the
   * terminal; they stay until the person tries again or leaves the session.
   */
  readable: Record<string, ReadableSummary>;
  /** The sessions being read now, by [`readableKey`]. */
  reading: Record<string, true>;
  /** Read a session's entries again, after it had none. */
  retryReadable: (hostId: string, sessionId: string) => void;
  screen: Screen;
  /**
   * Send `text` to Claude in a session, as typed then Enter, the way the
   * desktop sends a prompt.
   */
  sendMessage: (
    hostId: string,
    sessionId: string,
    text: string
  ) => Promise<void>;
  show: (screen: Screen) => void;
  /** Turn an open session's screen on, after what was asked before it. */
  showScreen: (hostId: string, sessionId: string) => Promise<void>;
  start: (deviceName: string) => Promise<void>;
  startError: string | null;
  states: Record<string, HostSummary>;
  /** Each session's view as last asked of Rust, by `host:session`. */
  views: Record<string, View>;
}

/** A session's key in `readable`. */
export function readableKey(hostId: string, sessionId: string): string {
  return `${hostId}/${sessionId}`;
}

/** `readable` without `key`. */
function without<T>(record: Record<string, T>, key: string): Record<string, T> {
  const { [key]: _gone, ...rest } = record;
  return rest;
}

/** Words for a failure, from whatever was thrown. */
function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The last view's number. Rust takes only a view newer than the last it
 * took, so calls may reach it in any order: nothing here waits on another.
 */
let viewSeq = 0;

/**
 * Ask Rust to show a session as `view` (`null`: closed). Rust keeps it
 * across links; it fails only for a computer not paired here.
 */
function setView(
  hostId: string,
  sessionId: string,
  view: View | null
): Promise<void> {
  const key = readableKey(hostId, sessionId);
  usePhone.setState((state) => ({
    views: view ? { ...state.views, [key]: view } : without(state.views, key),
  }));
  viewSeq += 1;
  return KriyonNative.setView(
    hostId,
    sessionId,
    viewSeq,
    view !== null,
    view?.screen ?? false,
    view?.entries ?? false
  );
}

/** Change part of a session's view; the rest stays as last asked. */
function changeView(
  hostId: string,
  sessionId: string,
  change: Partial<View>
): Promise<void> {
  const now = usePhone.getState().views[readableKey(hostId, sessionId)] ?? {
    entries: false,
    screen: false,
  };
  return setView(hostId, sessionId, { ...now, ...change });
}

/**
 * The phone app's copy of what Rust reports: this phone's id, its paired
 * computers and each one's latest state, the pairing in progress, and which
 * screen shows. Rust keeps the computers and decides; this keeps what it
 * said.
 */
export const usePhone = create<PhoneStore>((set, get) => ({
  back: () => {
    const { cancelPairing, screen, show } = get();
    if (screen.kind === "home") {
      return false;
    }
    if (screen.kind === "pair") {
      cancelPairing().catch(() => undefined);
    }
    show({ kind: "home" });
    return true;
  },
  cancelPairing: async () => {
    set({ pairing: { phase: "idle" } });
    await KriyonNative.cancelPairing().catch(() => undefined);
  },
  closeReadable: (hostId, sessionId) => {
    const key = readableKey(hostId, sessionId);
    set((state) => ({
      readable: state.readable[key]?.unavailable
        ? state.readable
        : without(state.readable, key),
      reading: without(state.reading, key),
    }));
    // Closing the stream stops its entries too.
    return setView(hostId, sessionId, null);
  },
  // The session stays open while its screen goes off (reading again).
  hideScreen: (hostId, sessionId) =>
    changeView(hostId, sessionId, { screen: false }),
  deviceId: null,
  entriesChanged: ({ hostId, sessionId, summary }) =>
    set((state) => {
      const key = readableKey(hostId, sessionId);
      // Late news from a read that was closed changes nothing.
      return state.reading[key]
        ? { readable: { ...state.readable, [key]: summary } }
        : {};
    }),
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
  forgetReadable: (hostId, sessionId) =>
    set((state) => ({
      readable: without(state.readable, readableKey(hostId, sessionId)),
    })),
  openReadable: (hostId, sessionId) => {
    const key = readableKey(hostId, sessionId);
    set((state) => ({ reading: { ...state.reading, [key]: true } }));
    return changeView(hostId, sessionId, { entries: true }).catch(
      (error: unknown) => {
        set((state) => ({ reading: without(state.reading, key) }));
        throw error;
      }
    );
  },
  // On the session open (openReadable): a fresh screen each time.
  showScreen: (hostId, sessionId) =>
    changeView(hostId, sessionId, { screen: true }),
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
  readable: {},
  reading: {},
  retryReadable: (hostId, sessionId) => {
    const key = readableKey(hostId, sessionId);
    if (!get().readable[key]?.unavailable) {
      return;
    }
    set((state) => ({ readable: without(state.readable, key) }));
    // The session stays open: its entries off, then on, are read afresh.
    changeView(hostId, sessionId, { entries: false }).catch(() => undefined);
    changeView(hostId, sessionId, { entries: true }).catch(() => undefined);
  },
  screen: { kind: "home" },
  views: {},
  sendMessage: (hostId, sessionId, text) =>
    // One after another, as typed: the order and the beat are the point.
    messageSteps(text).reduce(
      (sent, step) =>
        sent
          .then(() =>
            step.waitMs > 0
              ? new Promise<void>((done) => setTimeout(done, step.waitMs))
              : undefined
          )
          .then(() => KriyonNative.input(hostId, sessionId, step.bytes)),
      Promise.resolve()
    ),

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
