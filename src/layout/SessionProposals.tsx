import { type CSSProperties, useState } from "react";
import {
  type SessionProposal,
  startProblem,
  startProposal,
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
  const { request } = proposal;
  const [worktree, setWorktree] = useState(request.worktree);
  const [showTask, setShowTask] = useState(false);
  const [busy, setBusy] = useState(false);
  const dismiss = () =>
    useSessionProposals.getState().dismiss(request.requestId);
  const start = async () => {
    setBusy(true);
    const result = await startProposal(proposal, worktree);
    setBusy(false);
    if (result === null) {
      // A freed slot is starting it already; that run reports.
      return;
    }
    const problem = startProblem(result);
    if (!result.ok && result.bootstrap === null) {
      // Nothing was created: the card stays so they can try again.
      showToast(`“${request.title}”: ${problem}`, "error");
      return;
    }
    showToast(
      problem ? `“${request.title}”: ${problem}` : `Started “${request.title}”`,
      problem ? "error" : "success"
    );
  };
  return (
    <section
      aria-label={`Suggested session: ${request.title}`}
      data-testid={`session-proposal-${request.requestId}`}
      style={cardStyle}
    >
      <div style={rowStyle}>
        <div style={textStyle}>
          <div style={headStyle}>
            <span style={titleStyle}>{request.title}</span>
            <span style={reasonStyle}>
              {request.initiation === "user_asked"
                ? "You asked · starts when a busy session finishes"
                : "Suggested by Claude"}
            </span>
          </div>
          <div style={headStyle}>
            {showTask ? null : (
              <span style={previewStyle} title={request.prompt}>
                {request.prompt}
              </span>
            )}
            <button
              aria-expanded={showTask}
              className="kr-link"
              onClick={() => setShowTask((was) => !was)}
              style={toggleStyle}
              type="button"
            >
              {showTask ? "Hide task" : "Show task"}
            </button>
          </div>
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
      </div>
      {showTask ? (
        <div
          data-testid={`proposal-task-${request.requestId}`}
          style={taskStyle}
        >
          {request.prompt}
        </div>
      ) : null}
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
  background: tokens.color.chrome.content,
  borderLeft: `2px solid ${tokens.color.accent}`,
  display: "flex",
  flexDirection: "column",
  gap: tokens.space.sm,
  // The xl gutter the header and terminal use, less the 2px accent rule.
  padding: `${tokens.space.sm} ${tokens.space.xl} ${tokens.space.sm} calc(${tokens.space.xl} - 2px)`,
};

const rowStyle: CSSProperties = {
  alignItems: "center",
  display: "flex",
  gap: tokens.space.lg,
};

const textStyle: CSSProperties = {
  display: "flex",
  flex: 1,
  flexDirection: "column",
  gap: "2px",
  minWidth: 0,
};

const headStyle: CSSProperties = {
  alignItems: "baseline",
  display: "flex",
  gap: tokens.space.sm,
  minWidth: 0,
};

const titleStyle: CSSProperties = {
  color: tokens.color.ink.bright,
  flex: "none",
  fontSize: "12.5px",
  fontWeight: 500,
  maxWidth: "60%",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const reasonStyle: CSSProperties = {
  color: tokens.color.ink.muted,
  fontSize: "11.5px",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

/** Claude's task on one line: the card stays one row high however long
 *  the prompt runs. */
const previewStyle: CSSProperties = {
  color: tokens.color.ink.secondary,
  flex: "0 1 auto",
  fontSize: "12px",
  minWidth: 0,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const toggleStyle: CSSProperties = {
  background: "transparent",
  border: "none",
  cursor: "pointer",
  flex: "none",
  fontFamily: tokens.font.sans,
  fontSize: "11.5px",
  padding: 0,
};

/** The whole task, opened: capped at about eight lines and scrolled inside,
 *  so a long prompt never pushes the terminal off screen. */
const taskStyle: CSSProperties = {
  background: tokens.color.inputWell,
  borderRadius: tokens.radius.md,
  color: tokens.color.ink.secondary,
  fontSize: "12px",
  lineHeight: 1.5,
  maxHeight: "9.5em",
  overflowY: "auto",
  padding: `${tokens.space.sm} ${tokens.space.md}`,
  whiteSpace: "pre-wrap",
};

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
