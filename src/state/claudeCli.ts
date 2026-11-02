import { create } from "zustand";
import { type ClaudeCli, findClaudeCli } from "../ipc/bridge.ts";

/**
 * The [Claude CLI check] as the app holds it. `result` is `null` until the
 * first check returns; the app keeps working meanwhile, since `claude` is
 * almost always there.
 */
interface ClaudeCliStore {
  check: () => Promise<void>;
  /** A check is running (the shell PATH takes a moment to read). */
  checking: boolean;
  result: ClaudeCli | null;
  /** Continue anyway was chosen: no install screen for the rest of this run. */
  skip: () => void;
  skipped: boolean;
}

export const useClaudeCli = create<ClaudeCliStore>((set) => ({
  check: async () => {
    set({ checking: true });
    let result: ClaudeCli;
    try {
      result = await findClaudeCli();
    } catch {
      // A check that failed tells nothing; asking for an install could be wrong.
      result = { state: "unknown" };
    }
    set({ checking: false, result });
  },
  checking: false,
  result: null,
  skip: () => set({ skipped: true }),
  skipped: false,
}));

/** Whether to show the install screen: only once the check found no `claude`. */
export function needsClaudeInstall(
  state: Pick<ClaudeCliStore, "result" | "skipped">
): boolean {
  return state.result?.state === "missing" && !state.skipped;
}
