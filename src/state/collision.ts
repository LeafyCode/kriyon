import { sessionWorkingDir, type UiSession } from "./sessions.ts";

/**
 * A live, non-[Archived session] already working in `candidateDir`, or null.
 * The real file-collision hazard is two sessions in one checkout; a fresh
 * worktree has a unique path and so never collides. `ignoreSessionId` excludes
 * the session being spawned from (or the one whose dir is being re-checked).
 */
export function detectCollision(
  candidateDir: string,
  sessions: Record<string, UiSession>,
  ignoreSessionId?: string
): UiSession | null {
  for (const session of Object.values(sessions)) {
    if (session.id === ignoreSessionId || session.archivedAt !== null) {
      continue;
    }
    if (sessionWorkingDir(session) === candidateDir) {
      return session;
    }
  }
  return null;
}
