import { create } from "zustand";
import {
  type ControlAsk,
  onRemoteControlAsked,
  remoteLetDeviceType,
} from "../ipc/bridge.ts";
import { failureMessage } from "../ipc/failures.ts";
import { onEvent, stopAll } from "../ipc/onEvent.ts";

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
  /** Why letting a device type failed, if it did. */
  error: string | null;
  /** Let that device type in that session. */
  letType: (ask: ControlAsk) => Promise<void>;
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
  error: null,
  letType: async (ask) => {
    get().dismiss(ask);
    try {
      await remoteLetDeviceType(ask.sessionId, ask.deviceId);
      set({ error: null });
    } catch (error) {
      set({ error: failureMessage(error) });
    }
  },
}));

/** Hear devices asking to type. Returns the cleanup. */
export function installControlAskListener(): () => void {
  return stopAll([
    onEvent(onRemoteControlAsked, (ask) =>
      useControlAsks.getState().asked(ask, Date.now())
    ),
  ]);
}
