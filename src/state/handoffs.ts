import { create } from "zustand";

/**
 * [Handoff file]s waiting on a [Handoff card], keyed by the session whose turn
 * produced them. Fed by the backend's `session-handoff` event; the path has
 * already been validated in Rust. A newer handoff for the same session
 * replaces the older one.
 */
export interface ReadyHandoff {
  path: string;
  /** The [Handoff prompt] Rust picked; absent from an older backend. */
  prompt?: string;
}

interface HandoffsState {
  dismiss: (sessionId: string) => void;
  /** Ready handoff per session id. */
  ready: Record<string, ReadyHandoff>;
  show: (sessionId: string, path: string, prompt?: string) => void;
}

export const useHandoffs = create<HandoffsState>((set) => ({
  ready: {},
  show: (sessionId, path, prompt) =>
    set((s) => ({ ready: { ...s.ready, [sessionId]: { path, prompt } } })),
  dismiss: (sessionId) =>
    set((s) => {
      const { [sessionId]: _gone, ...rest } = s.ready;
      return { ready: rest };
    }),
}));

/** The seed prompt a [Handoff card]'s Open puts in the Spawn dialog: the
 *  [Handoff prompt] from the backend, or plain "read and continue". */
export function handoffSeed({ path, prompt }: ReadyHandoff): string {
  return prompt?.trim() ? prompt : `Read ${path} and continue.`;
}
