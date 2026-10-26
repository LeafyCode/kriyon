import type { Task } from "../types.ts";

/**
 * How far a session's [Task] list has got, as the sidebar row, the task strip
 * above the terminal and the turn recap show it. One derivation, so the three
 * can never disagree about "3/7" or which item is current.
 */
export interface TaskProgress {
  /** The item being worked on: the in-progress one (its active form when it
   *  has one), else the next pending one; `null` once every task is done. */
  current: string | null;
  done: number;
  /** Every task is done. */
  finished: boolean;
  /** "3/7". */
  label: string;
  total: number;
}

export function taskProgress(
  tasks: readonly Task[] | undefined
): TaskProgress | null {
  if (!tasks || tasks.length === 0) {
    return null;
  }
  const done = tasks.filter((t) => t.status === "completed").length;
  const working = tasks.find((t) => t.status === "in_progress");
  const next = tasks.find((t) => t.status === "pending");
  const current = working
    ? (working.activeForm ?? working.text)
    : (next?.text ?? null);
  return {
    current,
    done,
    finished: done === tasks.length,
    label: `${done}/${tasks.length}`,
    total: tasks.length,
  };
}
