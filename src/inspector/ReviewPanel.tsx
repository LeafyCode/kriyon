import { type CSSProperties, useState } from "react";
import { defaultBranch, diffWorktree, mergeWorktree } from "../ipc/bridge.ts";
import { failureMessage } from "../ipc/failures.ts";
import {
  useWorktreeRemoval,
  type WorktreeRemoval,
} from "../sidebar/useWorktreeRemoval.ts";
import { archiveSessionAndStop } from "../state/actions.ts";
import { useSessions } from "../state/sessions.ts";
import { button, sectionLabel } from "../theme/recipes.ts";
import { diffLineColors, tokens } from "../theme/tokens.ts";
import type {
  DiffLine,
  FileChange,
  FileDiff,
  MergeOutcome,
  SessionDiff,
} from "../types.ts";

// No rule of its own: the Details body already spaces its sections 22px
// apart, and a second divider weight in a 280px column reads as a table.
const sectionStyle: CSSProperties = {};

const labelStyle: CSSProperties = {
  ...sectionLabel(),
  display: "block",
  paddingBottom: "6px",
};

const buttonStyle: CSSProperties = button("secondary");

const mergeButtonStyle: CSSProperties = {
  ...buttonStyle,
  marginTop: "12px",
};

const mutedStyle: CSSProperties = {
  color: tokens.color.ink.muted,
  fontSize: "12.5px",
};

const errorStyle: CSSProperties = {
  color: tokens.color.status.error,
  fontSize: "12.5px",
};

const fileHeaderStyle: CSSProperties = {
  alignItems: "center",
  color: tokens.color.ink.primary,
  display: "flex",
  fontFamily: tokens.font.mono,
  fontSize: "12px",
  gap: "8px",
  marginBottom: "4px",
  marginTop: "12px",
  overflow: "hidden",
};

const filePathStyle: CSSProperties = {
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const hunkHeaderStyle: CSSProperties = {
  color: tokens.color.ink.faint,
  fontFamily: tokens.font.mono,
  fontSize: "11px",
  padding: "2px 0",
};

const textStyle: CSSProperties = {
  whiteSpace: "pre-wrap",
  wordBreak: "break-all",
};

function statusColor(status: FileChange): string {
  if (status === "added") {
    return tokens.color.add;
  }
  if (status === "deleted") {
    return tokens.color.del;
  }
  return tokens.color.ink.muted;
}

function statusBadgeStyle(status: FileChange): CSSProperties {
  return {
    color: statusColor(status),
    flex: "none",
    fontFamily: tokens.font.mono,
    fontSize: "10px",
    textTransform: "uppercase",
  };
}

function lineStyle(kind: DiffLine["kind"]): CSSProperties {
  const base: CSSProperties = {
    display: "flex",
    fontFamily: tokens.font.mono,
    fontSize: "11.5px",
    gap: "6px",
    lineHeight: 1.5,
    padding: "0 4px",
  };
  return { ...base, ...diffLineColors(kind) };
}

function sign(kind: DiffLine["kind"]): string {
  if (kind === "added") {
    return "+";
  }
  if (kind === "removed") {
    return "-";
  }
  return " ";
}

function FileBlock({ file }: { file: FileDiff }) {
  return (
    <div>
      <div style={fileHeaderStyle}>
        <span style={statusBadgeStyle(file.status)}>{file.status[0]}</span>
        <span style={filePathStyle}>{file.path}</span>
      </div>
      {file.hunks.map((hunk, hunkIndex) => (
        // Hunk headers can repeat across a file; the position is the stable key.
        // biome-ignore lint/suspicious/noArrayIndexKey: positional, append-only.
        <div key={hunkIndex}>
          <div style={hunkHeaderStyle}>{hunk.header}</div>
          {hunk.lines.map((line, index) => (
            // Diff lines have no stable id and may repeat; index is the position.
            // biome-ignore lint/suspicious/noArrayIndexKey: positional, append-only.
            <div key={index} style={lineStyle(line.kind)}>
              <span style={{ opacity: 0.6 }}>{sign(line.kind)}</span>
              <span style={textStyle}>{line.text}</span>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

function MergeResult({
  base,
  outcome,
}: {
  base: string;
  outcome: MergeOutcome;
}) {
  if (outcome.kind === "clean") {
    return (
      <div style={{ ...mutedStyle, marginTop: "10px" }}>
        Merged into {base}.
      </div>
    );
  }
  const plural = outcome.files.length === 1 ? "" : "s";
  return (
    <div style={{ marginTop: "10px" }}>
      <div style={{ color: tokens.color.del, fontSize: "12.5px" }}>
        {outcome.files.length} conflicted file{plural}:
      </div>
      {outcome.files.map((file) => (
        <div
          key={file}
          style={{
            color: tokens.color.ink.muted,
            fontFamily: tokens.font.mono,
            fontSize: "11.5px",
          }}
        >
          {file}
        </div>
      ))}
      <div style={{ ...mutedStyle, marginTop: "6px" }}>
        Resolve in the terminal, then merge again.
      </div>
    </div>
  );
}

/**
 * Offered once a merge lands clean: archive the session outright, or archive
 * and also remove its worktree — reusing {@link useWorktreeRemoval}'s
 * escalation ladder so a dirty tree confirms instead of silently staying on
 * disk while the session archives anyway.
 */
function ArchiveOffer({ removal }: { removal: WorktreeRemoval }) {
  return (
    <div data-testid="merge-archive-offer" style={{ marginTop: "8px" }}>
      <span style={mutedStyle}>Branch merged cleanly — tidy this session?</span>
      <div style={{ display: "flex", gap: "8px", marginTop: "6px" }}>
        <button
          className="kr-hover-surface"
          data-testid="merge-archive"
          onClick={() => {
            const id = useSessions.getState().activeSessionId;
            if (id) {
              archiveSessionAndStop(id);
            }
          }}
          style={buttonStyle}
          type="button"
        >
          Archive
        </button>
        <button
          className="kr-hover-surface"
          data-testid="merge-archive-remove"
          onClick={() => {
            removal.remove(false).catch(() => {
              // Failures surface via the confirm step or a toast.
            });
          }}
          style={buttonStyle}
          type="button"
        >
          Archive & remove worktree
        </button>
      </div>
      {removal.confirming ? (
        <div
          data-testid="merge-archive-remove-confirm"
          style={{ marginTop: "6px" }}
        >
          <span style={mutedStyle}>
            Uncommitted changes in this worktree will be lost. The branch and
            its commits are kept.
          </span>
          <div style={{ display: "flex", gap: "8px", marginTop: "6px" }}>
            <button
              className="kr-hover-surface"
              data-testid="merge-archive-remove-confirm-go"
              onClick={() => {
                removal.remove(true).catch(() => {
                  // Failures surface via a toast inside the removal flow.
                });
              }}
              style={{ ...buttonStyle, color: tokens.color.del }}
              type="button"
            >
              Discard changes & remove
            </button>
            <button
              className="kr-hover-surface"
              data-testid="merge-archive-remove-cancel"
              onClick={() => removal.cancel()}
              style={buttonStyle}
              type="button"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

type LoadPhase = "idle" | "loading" | "loaded" | "error";

/**
 * Review-and-merge surface for a loose-worktree session: shows the committed
 * changes the session made on its branch (vs the repo's default branch) and
 * offers a merge. Conflicts are surfaced read-only — the user resolves them in
 * the [Raw view]. All git work happens in the Rust core via the bridge.
 */
export function ReviewPanel({
  branch,
  repoRoot,
  worktreePath,
}: {
  branch: string;
  repoRoot: string;
  worktreePath: string;
}) {
  const [phase, setPhase] = useState<LoadPhase>("idle");
  const [diff, setDiff] = useState<SessionDiff | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [merge, setMerge] = useState<MergeOutcome | null>(null);
  const [merging, setMerging] = useState(false);
  // Same escalation ladder the sidebar's own "Remove worktree" uses: a dirty
  // tree refuses and escalates to an explicit confirm, a hard failure toasts.
  // ReviewPanel used to call `removeWorktree` directly and swallow the
  // rejection, which left a dirty worktree silently on disk.
  const activeSessionId = useSessions((s) => s.activeSessionId);
  const removal = useWorktreeRemoval(activeSessionId ?? "");

  async function review() {
    setPhase("loading");
    setError(null);
    setMerge(null);
    try {
      const base = await defaultBranch(repoRoot);
      const result = await diffWorktree(worktreePath, base);
      setDiff(result);
      setPhase("loaded");
    } catch (e) {
      setError(failureMessage(e));
      setPhase("error");
    }
  }

  async function runMerge() {
    setMerging(true);
    setError(null);
    try {
      setMerge(await mergeWorktree(repoRoot, branch));
    } catch (e) {
      setError(failureMessage(e));
    } finally {
      setMerging(false);
    }
  }

  return (
    <section style={sectionStyle}>
      <span style={labelStyle}>Review</span>

      {phase === "idle" || phase === "loading" ? (
        <button
          className="kr-hover-surface"
          disabled={phase === "loading"}
          onClick={review}
          style={buttonStyle}
          type="button"
        >
          {phase === "loading" ? "Loading…" : "Review changes"}
        </button>
      ) : null}

      {phase === "error" && error ? (
        <span style={errorStyle}>{error}</span>
      ) : null}

      {phase === "loaded" && diff ? (
        <div>
          {diff.files.length === 0 ? (
            <span style={mutedStyle}>No committed changes vs {diff.base}.</span>
          ) : (
            <>
              {diff.files.map((file) => (
                <FileBlock file={file} key={file.path} />
              ))}
              <button
                className="kr-hover-surface"
                disabled={merging}
                onClick={runMerge}
                style={mergeButtonStyle}
                type="button"
              >
                {merging ? "Merging…" : `Merge ${branch} → ${diff.base}`}
              </button>
            </>
          )}

          {merge ? <MergeResult base={diff.base} outcome={merge} /> : null}

          {merge?.kind === "clean" ? <ArchiveOffer removal={removal} /> : null}

          {error ? (
            <div style={{ ...errorStyle, marginTop: "8px" }}>{error}</div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
