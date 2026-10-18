import { create } from "zustand";

/**
 * The per-session [Composer draft]: unsent composer text, lifted out of
 * PromptBar so the [Prompt picker] can insert into it. `insertRequest` is a
 * one-shot mailbox: the picker posts text for a session; the mounted PromptBar
 * consumes it (inserting at the caret) and clears it. `seq` makes identical
 * consecutive requests distinguishable.
 */
export interface InsertRequest {
  seq: number;
  sessionId: string;
  text: string;
}

interface DraftsState {
  clearInsertRequest: () => void;
  drafts: Record<string, string>;
  insertRequest: InsertRequest | null;
  requestInsert: (sessionId: string, text: string) => void;
  setDraft: (sessionId: string, text: string) => void;
}

let nextSeq = 1;

export const useDrafts = create<DraftsState>((set) => ({
  drafts: {},
  insertRequest: null,
  setDraft: (sessionId, text) =>
    set((state) => ({ drafts: { ...state.drafts, [sessionId]: text } })),
  requestInsert: (sessionId, text) => {
    nextSeq += 1;
    set({ insertRequest: { seq: nextSeq, sessionId, text } });
  },
  clearInsertRequest: () => set({ insertRequest: null }),
}));
