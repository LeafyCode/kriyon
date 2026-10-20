import { create } from "zustand";

/**
 * A clicked link to a file outside every project, waiting on the user's
 * "open it anyway" ([Link target]). Kriyon opens only files inside a known
 * project by itself; one outside needs the user to say so, every time.
 */
export interface OutsideOpenRequest {
  /** Open it, with the user's leave. */
  confirm: () => void;
  path: string;
  /** Reveal in Finder rather than open. */
  reveal: boolean;
}

interface OutsideOpenState {
  ask: (request: OutsideOpenRequest) => void;
  dismiss: () => void;
  request: OutsideOpenRequest | null;
}

export const useOutsideOpen = create<OutsideOpenState>((set) => ({
  request: null,
  ask: (request) => set({ request }),
  dismiss: () => set({ request: null }),
}));
