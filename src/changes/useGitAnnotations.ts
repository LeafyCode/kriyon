import { useCallback, useEffect, useRef, useState } from "react";
import {
  type BaselineContent,
  blameFile,
  readSessionBaseline,
} from "../ipc/bridge.ts";
import { useRevalidateOn } from "../state/changesRefresh.ts";
import { useSessions } from "../state/sessions.ts";
import type { FileBlame } from "../types.ts";
import { BASELINE_REFETCH_INTERVAL_MS, toLf } from "./useFileEditorSession.ts";

/** The session-start text the highlight diffs against. A file absent from
 * the snapshot was created during the session: `""`, so every line is new.
 * Anything git can't show faithfully leaves the highlight off. */
function sessionStartText(result: BaselineContent): string | undefined {
  if (result.state === "untracked") {
    return "";
  }
  if (result.state === "tracked" && result.content !== null) {
    return toLf(result.content);
  }
}

/**
 * The open file's git annotations: its text when the session started (for
 * the session-change highlight) and who last touched each line (for blame).
 *
 * Both are decorations, so a failure only leaves them off — never an error
 * the user has to read. Both follow the session's landed refreshes, as the
 * gutter baseline does: a save, a commit or Claude's next edit moves them.
 * They share its {@link BASELINE_REFETCH_INTERVAL_MS} floor, since each is a
 * git spawn per open file.
 */
export function useGitAnnotations(
  cwd: string,
  path: string,
  sessionId: string | undefined,
  /** Unsaved edits are open: blame describes the file on disk, so once the
   * draft moves its line numbers stop lining up, and it waits for the save. */
  dirty = false
): { blame: FileBlame | undefined; sessionStart: string | undefined } {
  const baselineOid = useSessions((s) =>
    sessionId ? (s.sessions[sessionId]?.baselineOid ?? null) : null
  );
  const [blame, setBlame] = useState<FileBlame | undefined>(undefined);
  const [sessionStart, setSessionStart] = useState<string | undefined>(
    undefined
  );
  // Only the newest request for the newest file may land.
  const requestRef = useRef(0);
  const lastFetchRef = useRef(0);

  const fetchAll = useCallback(() => {
    requestRef.current += 1;
    const request = requestRef.current;
    lastFetchRef.current = Date.now();
    const current = () => requestRef.current === request;
    blameFile(cwd, path)
      .then((next) => {
        if (current()) {
          setBlame(next ?? undefined);
        }
      })
      .catch(() => {
        // A decoration: off, not an error.
      });
    if (baselineOid === null) {
      return;
    }
    readSessionBaseline(cwd, baselineOid, path)
      .then((result) => {
        if (current()) {
          setSessionStart(sessionStartText(result));
        }
      })
      .catch(() => {
        // A decoration: off, not an error.
      });
  }, [baselineOid, cwd, path]);

  useEffect(() => {
    setBlame(undefined);
    setSessionStart(undefined);
    fetchAll();
  }, [fetchAll]);

  useRevalidateOn(sessionId, () => {
    if (Date.now() - lastFetchRef.current >= BASELINE_REFETCH_INTERVAL_MS) {
      fetchAll();
    }
  });

  return { blame: dirty ? undefined : blame, sessionStart };
}
