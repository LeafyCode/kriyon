import { create } from "zustand";
import { type CommandCatalog, listSlashCommands } from "../ipc/bridge.ts";

/**
 * The live slash-command catalog, cached per working directory. Warmed on
 * session start so the popover is populated before the first `/`. The catalog
 * itself carries `degraded` when the probe fell back — the UI reads that, the
 * store just holds whatever resolved.
 */
interface CompletionsState {
  byCwd: Record<string, CommandCatalog>;
  catalogFor: (cwd: string) => CommandCatalog | undefined;
  loading: Record<string, boolean>;
  refresh: (cwd: string) => Promise<void>;
  warmup: (cwd: string) => Promise<void>;
}

async function load(
  cwd: string,
  set: (fn: (s: CompletionsState) => Partial<CompletionsState>) => void
): Promise<void> {
  set((s) => ({ loading: { ...s.loading, [cwd]: true } }));
  try {
    const catalog = await listSlashCommands(cwd);
    set((s) => ({ byCwd: { ...s.byCwd, [cwd]: catalog } }));
  } catch {
    // Leave the cache empty; the composer degrades to no slash suggestions.
  } finally {
    set((s) => ({ loading: { ...s.loading, [cwd]: false } }));
  }
}

export const useCompletions = create<CompletionsState>((set, get) => ({
  byCwd: {},
  loading: {},
  catalogFor: (cwd) => get().byCwd[cwd],
  warmup: async (cwd) => {
    const state = get();
    if (state.byCwd[cwd] || state.loading[cwd]) {
      return;
    }
    await load(cwd, set);
  },
  refresh: async (cwd) => {
    await load(cwd, set);
  },
}));
