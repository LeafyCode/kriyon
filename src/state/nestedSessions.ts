import { create } from "zustand";
import { nestedOutcome, takeSessionRequests } from "../ipc/bridge.ts";
import { branchSlug, validateBranchName } from "../spawn/branchName.ts";
import type { NestedRequest, SessionRequest } from "../types.ts";
import { showToast } from "../ui/Toast.tsx";
import {
  createSession,
  createWorktreeSession,
  isLaunching,
  type SpawnResult,
} from "./actions.ts";
import { nestedCapCount, useLayout } from "./layout.ts";
import { useSessions } from "./sessions.ts";

/**
 * [Nested session]s (ADR-0049): sessions started from another session — by
 * Claude, through the Companion's `start_session` tool, or by the person with
 * Split off — shown under it in the sidebar, each a real session with its own
 * terminal. The decision whether a request starts at once is the Rust core's
 * (`nested_outcome`); this module carries it out.
 */

/** A request Claude made that waits for the person: a [Session proposal]. */
export type SessionProposal = NestedRequest;

interface ProposalsState {
  add: (proposal: SessionProposal) => void;
  dismiss: (requestId: string) => void;
  /** Oldest first. In memory only: a restart forgets an unanswered one. */
  proposals: SessionProposal[];
}

export const useSessionProposals = create<ProposalsState>((set) => ({
  add: (proposal) =>
    set((state) =>
      state.proposals.some(
        (p) => p.request.requestId === proposal.request.requestId
      )
        ? {}
        : { proposals: [...state.proposals, proposal] }
    ),
  dismiss: (requestId) =>
    set((state) => ({
      proposals: state.proposals.filter(
        (p) => p.request.requestId !== requestId
      ),
    })),
  proposals: [],
}));

/** A branch for a nested worktree when Claude named none:
 *  `nested/<title-slug>-<suffix>`. */
export function branchForTitle(title: string, suffix: string): string {
  return `nested/${branchSlug(title) || "session"}-${suffix}`;
}

/**
 * Start a [Nested session] under `leadId`: in the lead session's own folder, or
 * on a new worktree of its project. It reports its first answer to the
 * lead when the lead session's Claude session id is known. `focus: false` opens
 * it in the background, which is how a session Claude started arrives.
 */
export function startNestedSession(
  leadId: string,
  request: Pick<SessionRequest, "branch" | "prompt" | "title" | "worktree"> & {
    /** Where the worktree goes, when the person chose; else beside the repo. */
    worktreePath?: string;
  },
  options: { focus: boolean }
): Promise<SpawnResult> {
  const state = useSessions.getState();
  const lead = state.sessions[leadId];
  const project = lead
    ? state.projects.find((p) => p.id === lead.projectId)
    : undefined;
  if (!(lead && project)) {
    return Promise.resolve({
      bootstrap: null,
      error: "The session that asked is gone.",
      ok: false,
    });
  }
  const report = lead.claudeSessionId
    ? { from: crypto.randomUUID(), to: lead.claudeSessionId }
    : undefined;
  const opts = {
    focus: options.focus,
    nestedUnder: lead.id,
    report,
    seedPrompt: request.prompt,
  };
  if (!request.worktree) {
    createSession(project, lead.worktreePath ?? lead.cwd, request.title, opts);
    return Promise.resolve({ bootstrap: null, error: null, ok: true });
  }
  // Claude's name, when git would take it; otherwise one from the title.
  const branch =
    request.branch && validateBranchName(request.branch) === null
      ? request.branch.trim()
      : branchForTitle(request.title, crypto.randomUUID().slice(0, 4));
  return createWorktreeSession(
    project,
    { branch, path: request.worktreePath },
    request.title,
    opts
  );
}

/** What went wrong starting one, for a toast; `null` when nothing did. A
 *  failed setup step still started the session. */
export function startProblem(result: SpawnResult): string | null {
  if (result.bootstrap && !result.bootstrap.ok) {
    return "it started, but the worktree's setup step failed";
  }
  return result.ok ? null : (result.error ?? "unknown error");
}

/**
 * Sessions counted against the [Nested session cap]: working, waiting on the
 * person mid-task, or still starting (launching or booting). A session
 * started a moment ago is idle until its first prompt lands, so starting
 * counts too: otherwise every request in one batch would see the same number
 * and all start.
 */
function busyCount(): number {
  const { bootPhase, sessions } = useSessions.getState();
  return Object.values(sessions).filter(
    (s) =>
      s.archivedAt === null &&
      (s.status === "running" ||
        s.status === "waiting" ||
        bootPhase[s.id] === "booting" ||
        isLaunching(s.id))
  ).length;
}

/** Carry out one request: start it, or keep it as a [Session proposal]. */
async function handleOne({
  leadSessionId,
  request,
}: NestedRequest): Promise<void> {
  if (!useSessions.getState().sessions[leadSessionId]) {
    return;
  }
  const cap = nestedCapCount(useLayout.getState().layout.nestedSessionCap);
  const outcome = await nestedOutcome(request.initiation, busyCount(), cap);
  if (outcome === "propose") {
    useSessionProposals.getState().add({ leadSessionId, request });
    return;
  }
  const problem = startProblem(
    await startNestedSession(leadSessionId, request, { focus: false })
  );
  if (problem) {
    showToast(`“${request.title}”: ${problem}`, "error");
  }
}

let draining: Promise<void> = Promise.resolve();
let sessionsLoaded = false;

/**
 * The saved sessions are in the store: requests can find the session that
 * asked. Takes the ones posted while Kriyon was closed.
 */
export function sessionRequestsReady(): Promise<void> {
  sessionsLoaded = true;
  return handleSessionRequests();
}

/**
 * Take every request the companions posted and carry each out, one at a
 * time and in order, so two arriving together count each other against the
 * cap. Safe to call as often as companions post; waits for the saved
 * sessions to load, since a request taken before then would find no lead.
 */
export function handleSessionRequests(): Promise<void> {
  if (!sessionsLoaded) {
    return draining;
  }
  draining = draining.then(async () => {
    let requests: NestedRequest[] = [];
    try {
      requests = await takeSessionRequests();
    } catch {
      // The store couldn't be read; the next post asks again.
    }
    for (const request of requests) {
      try {
        // biome-ignore lint/performance/noAwaitInLoops: in order, each counted.
        await handleOne(request);
      } catch (e) {
        // One failed request must not stop the queue for the rest of the run.
        showToast(
          `Could not start “${request.request.title}”: ${e instanceof Error ? e.message : String(e)}`,
          "error"
        );
      }
    }
  });
  return draining;
}
