import { create } from "zustand";
import {
  deletePrompt,
  importCommands,
  recordPromptUse,
  upsertPrompt,
} from "../ipc/bridge.ts";
import { failureMessage } from "../ipc/failures.ts";
import type { SavedPrompt } from "../types.ts";
import { showToast } from "../ui/Toast.tsx";
import { useSessions } from "./sessions.ts";

/**
 * The prompt library: every [Saved prompt], hydrated from SQLite at boot.
 * Mutations apply optimistically and fire-and-forget the IPC write — the
 * store is the UI's source of truth between hydrates.
 */
interface PromptLibraryState {
  markUsed: (id: string, nowMs: number) => void;
  prompts: SavedPrompt[];
  remove: (id: string) => void;
  save: (prompt: SavedPrompt) => void;
  setPrompts: (prompts: SavedPrompt[]) => void;
  toggleFavourite: (id: string, nowMs: number) => void;
}

function ignore(promise: Promise<unknown>): void {
  promise.catch(() => {
    // Fire-and-forget IPC; persistence errors are non-fatal.
  });
}

export const usePromptLibrary = create<PromptLibraryState>((set, get) => ({
  prompts: [],
  setPrompts: (prompts) => set({ prompts }),
  save: (prompt) => {
    set((state) => {
      const rest = state.prompts.filter((p) => p.id !== prompt.id);
      return { prompts: [...rest, prompt] };
    });
    ignore(upsertPrompt(prompt));
  },
  remove: (id) => {
    set((state) => ({ prompts: state.prompts.filter((p) => p.id !== id) }));
    ignore(deletePrompt(id));
  },
  markUsed: (id, nowMs) => {
    set((state) => ({
      prompts: state.prompts.map((p) =>
        p.id === id ? { ...p, lastUsedMs: nowMs, useCount: p.useCount + 1 } : p
      ),
    }));
    ignore(recordPromptUse(id));
  },
  toggleFavourite: (id, nowMs) => {
    const existing = get().prompts.find((p) => p.id === id);
    if (existing) {
      get().save({
        ...existing,
        favourite: !existing.favourite,
        updatedMs: nowMs,
      });
    }
  },
}));

/**
 * Import `.claude/commands/*.md` files as [Saved prompt]s: always the global
 * scope, plus the active session's project scope when there is one. Each
 * scope's failure is isolated — a stale project id must never discard the
 * already-fetched global commands. Skips a command whose `name` (or derived
 * title) case-insensitively matches an existing prompt's title, so re-running
 * is idempotent for untouched imports. Reports the outcome (and any error)
 * via {@link showToast}.
 */
export async function importPromptsFromCommands(): Promise<void> {
  try {
    const { activeSessionId, sessions } = useSessions.getState();
    const session = activeSessionId ? sessions[activeSessionId] : null;
    const scopes = [
      { label: "global", promise: importCommands(null) },
      ...(session
        ? [{ label: "project", promise: importCommands(session.projectId) }]
        : []),
    ];
    const settled = await Promise.allSettled(scopes.map((s) => s.promise));
    const failedLabels = scopes
      .filter((_, index) => settled[index].status === "rejected")
      .map((s) => s.label);
    if (failedLabels.length === scopes.length) {
      const [first] = settled;
      showToast(
        first.status === "rejected"
          ? failureMessage(first.reason)
          : "Could not import commands",
        "error"
      );
      return;
    }
    const imported = settled.flatMap((result) =>
      result.status === "fulfilled" ? result.value : []
    );

    let added = 0;
    let skipped = 0;
    for (const command of imported) {
      const title = command.description ?? command.name;
      const existingTitles = new Set(
        usePromptLibrary.getState().prompts.map((p) => p.title.toLowerCase())
      );
      if (
        existingTitles.has(command.name.toLowerCase()) ||
        existingTitles.has(title.toLowerCase())
      ) {
        skipped += 1;
        continue;
      }
      const now = Date.now();
      usePromptLibrary.getState().save({
        body: command.body,
        createdMs: now,
        favourite: false,
        id: crypto.randomUUID(),
        lastUsedMs: null,
        tags: ["imported"],
        title,
        updatedMs: now,
        useCount: 0,
      });
      added += 1;
    }

    showToast(
      `Imported ${added} prompt${added === 1 ? "" : "s"}${
        skipped ? ` (${skipped} already in library)` : ""
      }${
        failedLabels.length > 0
          ? ` (${failedLabels[0]} commands unavailable)`
          : ""
      }`
    );
  } catch (error) {
    showToast(failureMessage(error), "error");
  }
}

/**
 * Picker default order: favourites first, then most-recently-used, then most
 * used, then title — cheap frecency without a decay model.
 */
export function orderPrompts(prompts: SavedPrompt[]): SavedPrompt[] {
  return [...prompts].sort(
    (a, b) =>
      Number(b.favourite) - Number(a.favourite) ||
      (b.lastUsedMs ?? 0) - (a.lastUsedMs ?? 0) ||
      b.useCount - a.useCount ||
      a.title.localeCompare(b.title)
  );
}

/** The empty-library affordance copy, shared by both prompt surfaces. */
export const EMPTY_LIBRARY_COPY =
  'No saved prompts yet — use "Save last prompt…" or import your /commands from the palette.';

/**
 * Case-insensitive substring filter over title, tags, and body. A blank query
 * returns the input unchanged; ordering is the caller's job (see orderPrompts).
 */
export function filterPrompts(
  prompts: SavedPrompt[],
  query: string
): SavedPrompt[] {
  const needle = query.trim().toLowerCase();
  if (!needle) {
    return prompts;
  }
  return prompts.filter((p) =>
    `${p.title} ${p.tags.join(" ")} ${p.body}`.toLowerCase().includes(needle)
  );
}
