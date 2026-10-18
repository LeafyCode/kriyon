/**
 * The worktree-removal flow, extracted from the session row so its
 * escalation ladder is testable without rendering a sidebar: plain removal
 * first — git refuses a dirty tree, which escalates to an explicit confirm —
 * and only the confirm sends `force`. The branch (and its commits) always
 * survive: only the checkout folder goes. On success the session that lived
 * in the worktree is archived.
 */
import { useState } from "react";
import { removeWorktree } from "../ipc/bridge.ts";
import { archiveSessionAndStop } from "../state/actions.ts";
import { useSessions } from "../state/sessions.ts";
import { showToast } from "../ui/Toast.tsx";

export interface WorktreeRemoval {
  /** Leave the confirm step without removing anything. */
  cancel: () => void;
  /** The dirty-tree confirm step is showing. */
  confirming: boolean;
  /** Attempt removal; `force` only from the explicit discard confirm. */
  remove: (force: boolean) => Promise<void>;
}

export function useWorktreeRemoval(sessionId: string): WorktreeRemoval {
  const [confirming, setConfirming] = useState(false);

  async function remove(force: boolean): Promise<void> {
    const state = useSessions.getState();
    const current = state.sessions[sessionId];
    const project = state.projects.find((p) => p.id === current?.projectId);
    if (!(current?.worktreePath && project)) {
      return;
    }
    try {
      if (force) {
        await removeWorktree(project.path, current.worktreePath, true);
      } else {
        await removeWorktree(project.path, current.worktreePath);
      }
    } catch (error) {
      if (force) {
        showToast(
          `Could not remove the worktree: ${error instanceof Error ? error.message : String(error)}`,
          "error"
        );
        setConfirming(false);
      } else {
        setConfirming(true);
      }
      return;
    }
    setConfirming(false);
    archiveSessionAndStop(sessionId);
    showToast("Worktree removed — its branch is kept");
  }

  return { cancel: () => setConfirming(false), confirming, remove };
}
