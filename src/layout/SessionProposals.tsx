import { type CSSProperties, useState } from "react";
import {
  type SessionProposal,
  startNestedSession,
  useSessionProposals,
} from "../state/nestedSessions.ts";
import { useSessions } from "../state/sessions.ts";
import { button } from "../theme/recipes.ts";
import { tokens } from "../theme/tokens.ts";
import { showToast } from "../ui/Toast.tsx";

/**
 * The active session's [Session proposal]s: sessions Claude suggested
 * starting that wait for the person. Pinned under the session header, so
 * the suggestion sits with the work it came from. Nothing starts until Start
 * session is pressed.
 */
export function SessionProposals() {
  const activeId = useSessions((state) => state.activeSessionId);
  const proposals = useSessionProposals((state) => state.proposals);
  const mine = proposals.filter((p) => p.leadSessionId === activeId);
  if (mine.length === 0) {
    return null;
  }
  return (
    <div data-testid="session-proposals" style={stackStyle}>
      {mine.map((proposal) => (
        <ProposalCard key={proposal.request.requestId} proposal={proposal} />
      ))}
    </div>
  );
}

function ProposalCard({ proposal }: { proposal: SessionProposal }) {
  const { leadSessionId, request } = proposal;
  const [worktree, setWorktree] = useState(request.worktree);
  const [showTask, setShowTask] = useState(false);
  const [busy, setBusy] = useState(false);
  const dismiss = () =>
    useSessionProposals.getState().dismiss(request.requestId);
  const start = async () => {
    setBusy(true);
    const result = await startNestedSession(
      leadSessionId,
      { ...request, worktree },
      { focus: false }
    );
    setBusy(false);
    if (!result.ok) {
      showToast(
        `Could not start “${request.title}”: ${result.error ?? "unknown error"}`,
        "error"
      );
      return;
    }
    dismiss();
    showToast(`Started “${request.title}”`, "success");
  };
  return (
    <section
      aria-label={`Suggested session: ${request.title}`}
      data-testid={`session-proposal-${request.requestId}`}
      style={cardStyle}
    >
      <div style={textStyle}>
        <span style={kickerStyle}>Claude suggests a session</span>
        <span style={titleStyle}>{request.title}</span>
        <button
          aria-expanded={showTask}
          className="kr-link"
          onClick={() => setShowTask((was) => !was)}
          style={taskStyle(showTask)}
          title={showTask ? "Fold the task" : "Show the whole task"}
          type="button"
        >
          {request.prompt}
        </button>
      </div>
      <div style={actionsStyle}>
        <label style={worktreeStyle}>
          <input
            checked={worktree}
            onChange={(event) => setWorktree(event.target.checked)}
            type="checkbox"
          />
          Own worktree
        </label>
        <button
          className="kr-hover-surface"
          disabled={busy}
          onClick={dismiss}
          style={button("ghost", "sm")}
          type="button"
        >
          Not now
        </button>
        <button
          className="kr-hover-accent"
          disabled={busy}
          onClick={() => {
            start();
          }}
          style={button("primary", "sm")}
          type="button"
        >
          {busy ? "Starting…" : "Start session"}
        </button>
      </div>
    </section>
  );
}

const stackStyle: CSSProperties = {
  borderBottom: `1px solid ${tokens.color.line.soft}`,
  display: "flex",
  flex: "none",
  flexDirection: "column",
};

const cardStyle: CSSProperties = {
  alignItems: "center",
  background: tokens.color.chrome.content,
  borderLeft: `2px solid ${tokens.color.accent}`,
  display: "flex",
  gap: tokens.space.lg,
  padding: `${tokens.space.sm} ${tokens.space.xl} ${tokens.space.sm} 22px`,
};

const textStyle: CSSProperties = {
  display: "flex",
  flex: 1,
  flexDirection: "column",
  gap: "2px",
  minWidth: 0,
};

const kickerStyle: CSSProperties = {
  color: tokens.color.ink.muted,
  fontSize: "11px",
};

const titleStyle: CSSProperties = {
  color: tokens.color.ink.bright,
  fontSize: "12.5px",
  fontWeight: 500,
};

function taskStyle(open: boolean): CSSProperties {
  return {
    "--kr-link": tokens.color.ink.secondary,
    background: "transparent",
    border: "none",
    cursor: "pointer",
    display: "-webkit-box",
    fontFamily: tokens.font.sans,
    fontSize: "12px",
    lineHeight: 1.45,
    overflow: "hidden",
    padding: 0,
    textAlign: "left",
    whiteSpace: "pre-wrap",
    WebkitBoxOrient: "vertical",
    WebkitLineClamp: open ? "unset" : 2,
  } as CSSProperties;
}

const actionsStyle: CSSProperties = {
  alignItems: "center",
  display: "flex",
  flex: "none",
  gap: tokens.space.sm,
};

const worktreeStyle: CSSProperties = {
  alignItems: "center",
  color: tokens.color.ink.muted,
  cursor: "pointer",
  display: "flex",
  fontSize: "11.5px",
  gap: tokens.space.xs,
  marginRight: tokens.space.xs,
};
