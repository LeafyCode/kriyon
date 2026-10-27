import { formatMb } from "../sidebar/memoryChip.ts";
import type { SessionActivity } from "../types.ts";
import { type BootPhase, isStarting } from "./bootPhase.ts";
import type { UiSession } from "./sessions.ts";

/**
 * The [Stop cost]: what stopping a [Session]'s processes would destroy right
 * now. Closing, archiving and quitting all end the whole process tree, so they
 * all ask this one question — and therefore can never disagree about when a
 * warning is owed.
 *
 * Only what resume cannot bring back counts. The conversation always survives
 * (`claude --resume`), so an idle session costs nothing and closes without a
 * dialog. A turn in flight does not survive, and neither does a dev server
 * Claude left running in the background.
 *
 * Unsent work — a composer draft, unsaved edits — is a different loss (it goes
 * with the *row*, not the process) and stays with `unsentWorkFor`.
 */
export interface StopCost {
  /** Command lines of the [Background shell]s still running, to name them. */
  commands: string[];
  /** How busy the session is with Claude itself. */
  engagement: SessionEngagement;
}

/**
 * The [Session engagement]: how busy a session is with Claude itself.
 *
 * - `running` — a turn is in flight; stopping now discards it.
 * - `starting` — Claude is still launching. No hook has fired, so the status
 *   is still idle, but the session is visibly doing something and a quit ends
 *   it: exactly the surprise the gate exists to prevent.
 * - `quiet` — nothing a stop would interrupt.
 *
 * One value rather than two independently-sourced booleans. When `midTurn`
 * read `status` and `starting` read `bootPhase`, nothing but one store action
 * remembering to update both kept them apart — and when they both read true
 * the quit dialog said "Claude is still working in 1 session. 1 session still
 * starting up." about a single session, and counted it twice.
 */
export type SessionEngagement = "quiet" | "running" | "starting";

export const NO_STOP_COST: StopCost = {
  commands: [],
  engagement: "quiet",
};

/** The store slices a [Stop cost] reads. */
export interface StopCostView {
  activity: Record<string, SessionActivity>;
  bootPhase: Record<string, BootPhase>;
  exited: Record<string, boolean>;
}

/**
 * One session's [Stop cost].
 *
 * `waiting` is deliberately not mid-turn: the turn is blocked on the user, so
 * stopping it loses nothing a resume will not ask again. An `exited` session
 * costs nothing at all — a killed `claude` fires no closing hook, so both its
 * `running` status and its background shells are frozen claims about processes
 * that are already gone.
 *
 * Shell tracking is best-effort (ADR 0002), so this can miss a command. That is
 * fine: the [Tree stop] is what guarantees nothing is left behind; this only
 * decides whether to warn first.
 */
export function stopCostFor(
  session: UiSession | undefined,
  view: StopCostView
): StopCost {
  if (!session || view.exited[session.id] === true) {
    return NO_STOP_COST;
  }
  const shells = view.activity[session.id]?.shells ?? [];
  return {
    commands: shells
      .filter((shell) => shell.status === "running")
      .map((shell) => shell.cmd),
    engagement: sessionEngagement(session, view),
  };
}

/**
 * One session's [Session engagement], derived once from the three slices that
 * describe it. `running` wins over `starting`: a session that has begun a turn
 * is working, whatever its [Boot phase] still says.
 */
function sessionEngagement(
  session: UiSession,
  view: StopCostView
): SessionEngagement {
  if (session.status === "running") {
    return "running";
  }
  if (isStarting(view.bootPhase[session.id])) {
    return "starting";
  }
  return "quiet";
}

export function hasStopCost(cost: StopCost): boolean {
  return cost.engagement !== "quiet" || cost.commands.length > 0;
}

/** Every live session's [Stop cost] added up — what a quit would destroy. */
export interface TotalStopCost {
  commands: string[];
  /** How many sessions are still starting Claude up. */
  starting: number;
  /** How many sessions are mid-turn. */
  working: number;
}

/**
 * Whether a quit would destroy anything at all. The same question
 * {@link hasStopCost} asks of one session, asked of the total — one home, so
 * the gate and the close confirm cannot drift apart about when a warning is
 * owed.
 */
export function hasTotalStopCost(total: TotalStopCost): boolean {
  return total.working > 0 || total.starting > 0 || total.commands.length > 0;
}

/**
 * The whole app's [Stop cost]. Archived sessions are skipped: archiving stops a
 * session, so whatever status it froze with describes nothing still running.
 */
export function stopCostOfAll(
  view: StopCostView & { sessions: Record<string, UiSession> }
): TotalStopCost {
  const total: TotalStopCost = { commands: [], starting: 0, working: 0 };
  for (const session of Object.values(view.sessions)) {
    if (session.archivedAt !== null) {
      continue;
    }
    const cost = stopCostFor(session, view);
    total.commands.push(...cost.commands);
    // One value, so a session lands in exactly one bucket.
    if (cost.engagement === "running") {
      total.working += 1;
    } else if (cost.engagement === "starting") {
      total.starting += 1;
    }
  }
  return total;
}

/**
 * What separates command lines when a [Stop cost]'s list travels as one
 * string. A store selector must return a primitive or the row it feeds
 * re-renders on every unrelated update, so the list is packed — and the
 * separator has to be a character no command line can contain. A newline
 * cannot: Claude Code backgrounds multi-line commands routinely (a heredoc, a
 * chain split across lines), and joining on one shredded them into several
 * bogus entries that the dialog then counted as separate running commands.
 */
const COMMAND_SEPARATOR = "\u0000";

/** Pack a [Stop cost]'s command lines into one string a selector can compare. */
export function packCommands(commands: string[]): string {
  return commands.join(COMMAND_SEPARATOR);
}

/** The inverse of {@link packCommands}. An empty string is no commands. */
export function unpackCommands(packed: string): string[] {
  return packed === "" ? [] : packed.split(COMMAND_SEPARATOR);
}

/** How many command lines a warning spells out before summarising the rest. */
const NAMED_COMMANDS = 3;

/** `1 session`, `2 sessions`. */
export function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/**
 * `2 running commands` — the count every warning leads with. The command lines
 * follow as a list ({@link listedCommands}) rather than a comma-spliced tail:
 * a shell one-liner is long and full of punctuation, so inlining two of them
 * buries the sentence that says what is about to happen.
 */
export function describeCommands(commands: string[]): string {
  return plural(commands.length, "running command");
}

/**
 * The command lines to show under that count, capped so a session that
 * backgrounded a dozen things still fits in a dialog.
 */
export function listedCommands(commands: string[]): string[] {
  const rest = commands.length - NAMED_COMMANDS;
  const named = commands.slice(0, NAMED_COMMANDS);
  return rest > 0 ? [...named, `and ${rest} more`] : named;
}

/**
 * Below this a stop gave back nothing worth a toast — a bare shell at its
 * prompt, or a session that was already asleep.
 */
const WORTH_MENTIONING_MB = 100;

/**
 * What stopping a session gave back, as a one-line note — or `null` when it was
 * nothing worth saying, so an ordinary close stays silent.
 *
 * Closing used to be invisible: the row vanished and (before the [Tree stop])
 * most of its memory did not. Now that it really is released, saying so is what
 * lets a user trust that closing a session is how you get memory back. `mb` is
 * the session's last [Session footprint] — its whole tree, which is exactly
 * what a stop ends — so it is "about", never a promise.
 */
export function freedMemoryNote(
  verb: "Archived" | "Closed",
  mb: number | undefined
): string | null {
  if (mb === undefined || mb < WORTH_MENTIONING_MB) {
    return null;
  }
  return `${verb} — freed about ${formatMb(mb)}`;
}
