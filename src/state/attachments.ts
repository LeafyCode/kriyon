import { create } from "zustand";
import type { Attachment } from "../ipc/bridge.ts";

/**
 * Each session's composer [Attachment]s, waiting to go with the next message.
 * Kept beside the [Composer draft] so switching sessions keeps both.
 */
interface AttachmentsState {
  add: (sessionId: string, attachments: Attachment[]) => void;
  bySession: Record<string, Attachment[]>;
  clear: (sessionId: string) => void;
  remove: (sessionId: string, path: string) => void;
  set: (sessionId: string, attachments: Attachment[]) => void;
}

export const useAttachments = create<AttachmentsState>((set) => ({
  bySession: {},
  add: (sessionId, attachments) =>
    set((s) => {
      const have = s.bySession[sessionId] ?? [];
      const fresh = attachments.filter(
        (a, at) =>
          !have.some((h) => h.path === a.path) &&
          attachments.findIndex((b) => b.path === a.path) === at
      );
      if (fresh.length === 0) {
        return s;
      }
      return {
        bySession: { ...s.bySession, [sessionId]: [...have, ...fresh] },
      };
    }),
  remove: (sessionId, path) =>
    set((s) => ({
      bySession: {
        ...s.bySession,
        [sessionId]: (s.bySession[sessionId] ?? []).filter(
          (a) => a.path !== path
        ),
      },
    })),
  set: (sessionId, attachments) =>
    set((s) => ({ bySession: { ...s.bySession, [sessionId]: attachments } })),
  clear: (sessionId) =>
    set((s) => {
      if (!(sessionId in s.bySession)) {
        return s;
      }
      const { [sessionId]: _gone, ...rest } = s.bySession;
      return { bySession: rest };
    }),
}));
