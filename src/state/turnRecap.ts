import type { SessionActivity, SessionStatus, StudioEvent } from "../types.ts";
import { digestEvents } from "./eventDigest.ts";
import { taskProgress } from "./taskProgress.ts";

/**
 * The [Turn recap]: what Claude's last turn did, shown when it stops — the
 * files it changed, the commands it ran (and how many failed), where the task
 * list stands, its last line, and, when it is waiting, what it needs.
 * Deterministic and zero-token, the turn's [Event digest]; a turn
 * that only talked (no files, no commands) needs no recap.
 */
export interface TurnRecap {
  commands: number;
  failedCommands: number;
  /** Files changed, in the order first touched. */
  files: string[];
  /** The id of the prompt that started the turn: a dismissal is for this
   *  turn only. */
  key: string;
  /** What a waiting session asks for, or null. */
  needs: string | null;
  /** The first line of Claude's last reply in the turn. */
  reply: string | null;
  tasks: { done: number; total: number } | null;
}

/** A recap is for a session that stopped: finished, or waiting on the person. */
const STOPPED: ReadonlySet<SessionStatus> = new Set(["done", "waiting"]);

/** Where the last turn starts: the newest prompt's index, or -1. */
function lastPromptAt(events: readonly StudioEvent[]): number {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    if (events[i]?.kind === "prompt") {
      return i;
    }
  }
  return -1;
}

export function turnRecap(
  events: readonly StudioEvent[] | undefined,
  activity: SessionActivity | undefined,
  status: SessionStatus
): TurnRecap | null {
  if (!(events && STOPPED.has(status))) {
    return null;
  }
  const start = lastPromptAt(events);
  const prompt = events[start];
  if (!prompt) {
    return null;
  }
  const turn = digestEvents(events.slice(start + 1));
  if (turn.files.length === 0 && turn.commands === 0) {
    return null;
  }
  const progress = taskProgress(activity?.tasks);
  return {
    commands: turn.commands,
    failedCommands: turn.failedCommands,
    files: turn.files,
    key: prompt.id,
    needs: status === "waiting" ? (activity?.pendingAsk?.text ?? null) : null,
    reply: turn.lastLine,
    tasks: progress ? { done: progress.done, total: progress.total } : null,
  };
}

/** "Changed 3 files · ran 4 commands, 1 failed · 2 of 5 tasks done". */
export function recapHeadline(recap: TurnRecap): string {
  const parts: string[] = [];
  if (recap.files.length > 0) {
    const n = recap.files.length;
    parts.push(`Changed ${n} file${n === 1 ? "" : "s"}`);
  }
  if (recap.commands > 0) {
    const ran = `ran ${recap.commands} command${recap.commands === 1 ? "" : "s"}`;
    parts.push(
      recap.failedCommands > 0 ? `${ran}, ${recap.failedCommands} failed` : ran
    );
  }
  if (recap.tasks) {
    parts.push(`${recap.tasks.done} of ${recap.tasks.total} tasks done`);
  }
  const text = parts.join(" · ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}
