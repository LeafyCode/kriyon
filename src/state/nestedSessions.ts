import { create } from "zustand";
import { nestedOutcome, takeSessionRequests } from "../ipc/bridge.ts";
import { branchSlug, validateBranchName } from "../spawn/branchName.ts";
import type { NestedRequest, SessionRequest } from "../types.ts";
import { showToast } from "../ui/Toast.tsx";
import {
  createSession,
  createWorktreeSession,
  failedSetupSteps,
  type SpawnResult,
} from "./actions.ts";
import { isStarting } from "./bootPhase.ts";
import { useLayout } from "./layout.ts";
import { isPutAway, useSessions } from "./sessions.ts";

/**
 * [Nested session]s (ADR-0049): sessions started from another session — by
 * Claude, through the Companion's `start_session` tool, or by the person with
 * Split off — shown under it in the sidebar, each a real session with its own
 * terminal. The decision whether a request starts at once is the Rust core's
 * (`nested_outcome`); this module carries it out.
 */

/** A request Claude made that waits: a [Session proposal]. One the person
 *  asked for that only the cap held back starts by itself when a slot frees
 *  ({@link installHeldBackStarts}); Claude's own idea waits for a click. */
export type SessionProposal = NestedRequest;

interface ProposalsState {
  add: (proposal: SessionProposal) => void;
  dismiss: (requestId: string) => void;
  /** Oldest first. In memory only: a restart forgets an unanswered one. */
  proposals: SessionProposal[];
  /** Request ids {@link startProposal} is starting right now. */
  starting: string[];
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
  starting: [],
}));

/**
 * Start a [Session proposal] from its card or from a freed slot, once: `null`
 * when it is already being started, so the two can't start it twice. It
 * leaves the list once something was created; when nothing was, it stays so
 * the person can try again.
 */
export async function startProposal(
  { leadSessionId, request }: SessionProposal,
  worktree: boolean
): Promise<SpawnResult | null> {
  const id = request.requestId;
  if (useSessionProposals.getState().starting.includes(id)) {
    return null;
  }
  useSessionProposals.setState((s) => ({ starting: [...s.starting, id] }));
  try {
    const result = await startNestedSession(
      leadSessionId,
      { ...request, worktree },
      { focus: false }
    );
    if (result.ok || result.bootstrap !== null) {
      useSessionProposals.getState().dismiss(id);
    }
    return result;
  } finally {
    useSessionProposals.setState((s) => ({
      starting: s.starting.filter((x) => x !== id),
    }));
  }
}

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
  options: {
    focus: boolean;
    /** The person started it with [Split off]; its report says so. */
    splitOff?: boolean;
  }
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
    ? {
        from: crypto.randomUUID(),
        splitOff: options.splitOff,
        to: lead.claudeSessionId,
      }
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
  const suffix = () => crypto.randomUUID().slice(0, 4);
  const start = (branch: string) =>
    createWorktreeSession(
      project,
      { branch, path: request.worktreePath },
      request.title,
      opts
    );
  // Claude's name, when git would take it; otherwise one from the title.
  const named = request.branch?.trim();
  if (!(named && validateBranchName(named) === null)) {
    return start(branchForTitle(request.title, suffix()));
  }
  // The person typed this one in Split off: start on it or say why not.
  if (options.splitOff) {
    return start(named);
  }
  // Claude's name is only a hint: nobody is told the branch, and the session
  // runs wherever it starts. So when that name is taken (often by an earlier
  // session on the same task), one retry with a fresh suffix starts it anyway.
  // A failure with no setup report created nothing, so the retry is clean.
  return start(named).then((first) =>
    first.ok || first.bootstrap ? first : start(`${named}-${suffix()}`)
  );
}

/** What went wrong starting one, for a toast; `null` when nothing did. A
 *  failed setup step still started the session. */
export function startProblem(result: SpawnResult): string | null {
  if (result.bootstrap && !result.bootstrap.ok) {
    return `it started, but the worktree's ${failedSetupSteps(result.bootstrap)} failed`;
  }
  return result.ok ? null : (result.error ?? "unknown error");
}

/**
 * Sessions counted against the [Nested session cap]: working, waiting on the
 * person mid-task, or still starting (launching or booting). A session
 * started a moment ago is idle until its first prompt lands, so starting
 * counts too: otherwise every request in one batch would see the same number
 * and all start. The session that asked is left out: it is always mid-turn
 * when it asks, so counting it would make the same prompt start a session or
 * hold it back depending only on how soon that turn ends.
 */
function busyCount(askingId: string): number {
  const { bootPhase, sessions } = useSessions.getState();
  return Object.values(sessions).filter(
    (s) =>
      s.id !== askingId &&
      // A put-away session keeps the status it was stopped with, so it must
      // not count against the cap as if it were still running.
      !isPutAway(s) &&
      (s.status === "running" ||
        s.status === "waiting" ||
        isStarting(bootPhase[s.id]))
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
  const cap = useLayout.getState().layout.nestedSessionCap;
  const outcome = await nestedOutcome(
    request.initiation,
    busyCount(leadSessionId),
    cap
  );
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

/** A held-back start is queued on {@link draining} and not yet run. */
let releasing = false;
/** Something changed while {@link releasing}: look again once it ends. */
let releaseAgain = false;
/** What the core was last asked about a held-back session, so a store change
 *  that moves none of it doesn't ask again. */
let lastAsked = "";

/** The oldest session the person asked for that the cap held back, whose
 *  lead is still open and that nothing is starting already. */
function nextHeldBack(): SessionProposal | undefined {
  const { proposals, starting } = useSessionProposals.getState();
  const { sessions } = useSessions.getState();
  return proposals.find((p) => {
    const lead = sessions[p.leadSessionId];
    return (
      p.request.initiation === "user_asked" &&
      lead !== undefined &&
      !isPutAway(lead) &&
      !starting.includes(p.request.requestId)
    );
  });
}

/** The core's inputs for starting `proposal` now. */
function askFor(proposal: SessionProposal) {
  const running = busyCount(proposal.leadSessionId);
  const cap = useLayout.getState().layout.nestedSessionCap;
  return {
    cap,
    key: `${proposal.request.requestId}:${running}:${cap}`,
    running,
  };
}

/**
 * Ask the core about one held-back session and start it if it fits.
 * `false` when the core says it doesn't, which ends the run.
 */
async function releaseOne(next: SessionProposal): Promise<boolean> {
  const ask = askFor(next);
  lastAsked = ask.key;
  const outcome = await nestedOutcome("user_asked", ask.running, ask.cap);
  if (outcome !== "start") {
    return false;
  }
  // The answer took a moment: the request may have been started, dismissed
  // or had its lead archived since. Then the run asks about the next one.
  if (nextHeldBack()?.request.requestId !== next.request.requestId) {
    return true;
  }
  const result = await startProposal(next, next.request.worktree);
  if (result === null) {
    return true;
  }
  // Not kept for another try: a freed slot would try it again unasked.
  useSessionProposals.getState().dismiss(next.request.requestId);
  const problem = startProblem(result);
  showToast(
    problem
      ? `“${next.request.title}”: ${problem}`
      : `Started “${next.request.title}”`,
    problem ? "error" : "success"
  );
  return true;
}

/**
 * Start held-back sessions the person asked for, oldest first, while the
 * Rust core says they fit. Queued behind any requests being handled, so
 * they count each other.
 */
function releaseHeldBack(): void {
  if (releasing) {
    releaseAgain = true;
    return;
  }
  const first = nextHeldBack();
  if (!first || askFor(first).key === lastAsked) {
    return;
  }
  releasing = true;
  draining = draining.then(async () => {
    try {
      for (let next = nextHeldBack(); next; next = nextHeldBack()) {
        // biome-ignore lint/performance/noAwaitInLoops: in order, each counted.
        if (!(await releaseOne(next))) {
          return;
        }
      }
    } catch {
      // The decision couldn't be asked; the next change tries again.
      lastAsked = "";
    } finally {
      releasing = false;
      if (releaseAgain) {
        releaseAgain = false;
        releaseHeldBack();
      }
    }
  });
}

/** Drop the proposals of a lead that was closed: nobody can see them. */
function dropOrphanedProposals(): void {
  const { sessions } = useSessions.getState();
  const { dismiss, proposals } = useSessionProposals.getState();
  for (const p of proposals) {
    if (!sessions[p.leadSessionId]) {
      dismiss(p.request.requestId);
    }
  }
}

/**
 * Start a held-back session the moment a slot frees: when a session stops
 * being busy, is archived, or the person raises the cap. Returns the
 * unsubscribe.
 */
export function installHeldBackStarts(): () => void {
  const stopSessions = useSessions.subscribe((state, prev) => {
    if (state.sessions !== prev.sessions) {
      dropOrphanedProposals();
    }
    if (
      state.sessions !== prev.sessions ||
      state.bootPhase !== prev.bootPhase
    ) {
      releaseHeldBack();
    }
  });
  const stopLayout = useLayout.subscribe((state, prev) => {
    if (state.layout.nestedSessionCap !== prev.layout.nestedSessionCap) {
      releaseHeldBack();
    }
  });
  return () => {
    stopSessions();
    stopLayout();
  };
}

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
