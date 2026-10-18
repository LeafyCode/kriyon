import { create } from "zustand";
import type { Attachment } from "../ipc/bridge.ts";

/**
 * The last [Sent prompt] per session: what the composer just wrote to the
 * terminal. The [Structured view] shows it at once instead of waiting for the
 * companion's row (a few seconds), and Esc puts it back in the composer if
 * Claude never started on it ([Taken-back prompt]). Cleared once Claude has.
 */
export interface SentPrompt {
  at: number;
  attachments: Attachment[];
  /** The composer draft it was sent from, chips and all. */
  draft: string;
  /** The message text as sent (trimmed). */
  text: string;
}

interface SentPromptsState {
  clear: (sessionId: string) => void;
  note: (sessionId: string, sent: SentPrompt) => void;
  sent: Record<string, SentPrompt>;
}

export const useSentPrompts = create<SentPromptsState>((set) => ({
  sent: {},
  note: (sessionId, sent) =>
    set((s) => ({
      sent: { ...s.sent, [sessionId]: { ...sent, text: sent.text.trim() } },
    })),
  clear: (sessionId) =>
    set((s) => {
      if (!(sessionId in s.sent)) {
        return s;
      }
      const { [sessionId]: _gone, ...rest } = s.sent;
      return { sent: rest };
    }),
}));
