import { useChanges } from "../state/changes.ts";
import { useCommandCenter } from "../state/commandCenter.ts";
import { useCompletions } from "../state/completions.ts";
import { useDrafts } from "../state/drafts.ts";
import { useLayout } from "../state/layout.ts";
import { usePromptLibrary } from "../state/promptLibrary.ts";
import { useSessions } from "../state/sessions.ts";
import { useTerminals } from "../state/terminals.ts";
import { useUi } from "../state/ui.ts";

/**
 * Dev-only QA seam: expose the zustand stores on `window.__kriyon` so an
 * automated browser session (agent QA against `pnpm dev`) can seed projects,
 * sessions, statuses, activity, composer drafts, diffs, and the prompt library
 * without the Tauri backend. `useCommandCenter` is included so QA can emit
 * the watcher-liveness heartbeats the command center needs — without them
 * every standing correctly reads `unknown`, so the command center is
 * untestable in the browser. Never installed in production builds — the
 * caller gates on `import.meta.env.DEV`, and the hook itself refuses outside
 * dev as a second lock.
 */
export function installQaHook(): void {
  if (!import.meta.env.DEV) {
    return;
  }
  (
    window as unknown as {
      __kriyon?: {
        useChanges: typeof useChanges;
        useCommandCenter: typeof useCommandCenter;
        useCompletions: typeof useCompletions;
        useDrafts: typeof useDrafts;
        useLayout: typeof useLayout;
        usePromptLibrary: typeof usePromptLibrary;
        useSessions: typeof useSessions;
        useTerminals: typeof useTerminals;
        useUi: typeof useUi;
      };
    }
  ).__kriyon = {
    useChanges,
    useCommandCenter,
    useCompletions,
    useDrafts,
    useLayout,
    usePromptLibrary,
    useSessions,
    useTerminals,
    useUi,
  };
}
