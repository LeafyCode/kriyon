import { create } from "zustand";

/**
 * The [Usage card] shown per session: asked for from the Structured view's
 * composer (`/usage`, `/cost`), kept until closed or asked for again. Never
 * persisted and never sent to Claude: the figures on it are live.
 */
export interface ShownUsageCard {
  /** When it was asked for, to place it among the turns. */
  at: number;
  /** The command as typed, shown as the prompt it answers. */
  command: string;
}

interface UsageCardsState {
  close: (sessionId: string) => void;
  show: (sessionId: string, card: ShownUsageCard) => void;
  shown: Record<string, ShownUsageCard>;
}

export const useUsageCards = create<UsageCardsState>((set) => ({
  shown: {},
  show: (sessionId, card) =>
    set((s) => ({ shown: { ...s.shown, [sessionId]: card } })),
  close: (sessionId) =>
    set((s) => {
      if (!(sessionId in s.shown)) {
        return s;
      }
      const { [sessionId]: _gone, ...rest } = s.shown;
      return { shown: rest };
    }),
}));
