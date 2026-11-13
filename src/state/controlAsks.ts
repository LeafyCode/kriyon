import { create } from "zustand";
import {
  type ControlAsk,
  onRemoteControlAsked,
  remoteLetDeviceType,
} from "../ipc/bridge.ts";
import { failureMessage } from "../ipc/failures.ts";
import { onEvent, stopAll } from "../ipc/onEvent.ts";
import { showToast } from "../ui/Toast.tsx";

/**
 * Devices that asked for [Typing control] of a session the person typed in
 * just now: the host's ten-second rule kept it from them, and the person can
 * let one type ("Let <device> type", spec §7). Shown a while, then dropped:
 * the device asks again if it still wants to.
 */

/** How long an unanswered ask stays shown. */
export const ASK_SHOWN_MS = 30_000;

interface Asked extends ControlAsk {
  at: number;
}

interface ControlAsksStore {
  /** A device asked (`remote-control-asked`) at `now`. */
  asked: (ask: ControlAsk, now: number) => void;
  asks: Asked[];
  /** The asks still shown at `now`, newest first. */
  current: (now: number) => Asked[];
  /** Not now: drop it. */
  dismiss: (ask: ControlAsk) => void;
  /** Let that device type in that session; a refusal shows as a toast. */
  letType: (ask: ControlAsk) => Promise<void>;
  /** Forget the asks no longer shown at `now`. */
  prune: (now: number) => void;
}

const same = (a: ControlAsk, b: ControlAsk) =>
  a.sessionId === b.sessionId && a.deviceId === b.deviceId;

export const useControlAsks = create<ControlAsksStore>((set, get) => ({
  asked: (ask, now) =>
    set((state) => ({
      asks: [
        { ...ask, at: now },
        ...state.asks.filter((one) => !same(one, ask)),
      ],
    })),
  asks: [],
  current: (now) =>
    get()
      .asks.filter((ask) => now - ask.at < ASK_SHOWN_MS)
      .sort((a, b) => b.at - a.at),
  dismiss: (ask) =>
    set((state) => ({ asks: state.asks.filter((one) => !same(one, ask)) })),
  letType: async (ask) => {
    get().dismiss(ask);
    try {
      await remoteLetDeviceType(ask.sessionId, ask.deviceId);
    } catch (error) {
      showToast(failureMessage(error), "error");
    }
  },
  prune: (now) =>
    set((state) => {
      const kept = state.asks.filter((ask) => now - ask.at < ASK_SHOWN_MS);
      return kept.length === state.asks.length ? state : { asks: kept };
    }),
}));

/** Hear devices asking to type. Returns the cleanup. */
export function installControlAskListener(): () => void {
  return stopAll([
    onEvent(onRemoteControlAsked, (ask) =>
      useControlAsks.getState().asked(ask, Date.now())
    ),
  ]);
}

/**
 * What the panel says of `ask`: the device, and the session it wants to type
 * in with its project, so the person can tell which one with several open.
 */
export function askWords(
  ask: ControlAsk,
  sessions: Record<string, { projectId: string; title: string }>,
  projects: readonly { id: string; name: string }[]
): string {
  const session = sessions[ask.sessionId];
  if (session === undefined) {
    return `${ask.deviceName} wants to type`;
  }
  const project = projects.find((one) => one.id === session.projectId);
  const where =
    project === undefined
      ? session.title
      : `${session.title} (${project.name})`;
  return `${ask.deviceName} wants to type in ${where}`;
}
