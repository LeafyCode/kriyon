/**
 * The worktree-removal flow, extracted from the session row so its
 * escalation ladder is testable without rendering a sidebar: plain removal
 * first — git refuses a dirty tree, which escalates to an explicit confirm —
 * and only the confirm sends `force`. The branch (and its commits) always
 * survive: only the checkout folder goes. On success the session that lived
 * in the worktree is archived and the worktree's terminals are closed.
 */
import { useRef, useState } from "react";
import { removeWorktree } from "../ipc/bridge.ts";
import { archiveSessionAndStop } from "../state/actions.ts";
import { useSessions } from "../state/sessions.ts";
import { terminalScope, useTerminals } from "../state/terminals.ts";
import { showToast } from "../ui/Toast.tsx";

export interface WorktreeRemoval {
  /** Leave either confirm step without removing anything. */
  cancel: () => void;
  /** The dirty-tree confirm step is showing. */
  confirming: boolean;
  /** The busy-terminals confirm step is showing: a command is running in one
   *  of the worktree's terminals, and removing stops it. */
  confirmingStop: boolean;
  /** Attempt removal; `force` only from the explicit discard confirm. */
  remove: (force: boolean) => Promise<void>;
  /** Answer the busy-terminals confirm: go on, stopping the running command. */
  stopAndRemove: () => Promise<void>;
}

export function useWorktreeRemoval(sessionId: string): WorktreeRemoval {
  const [confirming, setConfirming] = useState(false);
  const [confirmingStop, setConfirmingStop] = useState(false);
  // Set once the person agreed to stop running terminals, so the dirty-tree
  // confirm that may follow doesn't ask about them again.
  const stopAgreed = useRef(false);

  async function remove(force: boolean): Promise<void> {
    const state = useSessions.getState();
    const current = state.sessions[sessionId];
    const project = state.projects.find((p) => p.id === current?.projectId);
    if (!(current?.worktreePath && project)) {
      return;
    }
    const scope = terminalScope(project.id, current.worktreePath, project.path);
    // Removing the folder stops its terminals; a running command (a dev
    // server, a build) is never stopped without asking — the same rule tab
    // close, park and quit keep.
    if (!stopAgreed.current && useTerminals.getState().isScopeBusy(scope)) {
      setConfirmingStop(true);
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
        stopAgreed.current = false;
        setConfirming(false);
      } else {
        setConfirming(true);
      }
      return;
    }
    stopAgreed.current = false;
    setConfirming(false);
    // Its folder is gone, so its terminals have nowhere to run.
    useTerminals.getState().dropScope(scope);
    archiveSessionAndStop(sessionId);
    showToast("Worktree removed — its branch is kept");
  }

  function stopAndRemove(): Promise<void> {
    stopAgreed.current = true;
    setConfirmingStop(false);
    return remove(false);
  }

  function cancel(): void {
    stopAgreed.current = false;
    setConfirming(false);
    setConfirmingStop(false);
  }

  return { cancel, confirming, confirmingStop, remove, stopAndRemove };
}
