/**
 * A session's [Readable view] as a device's screens show it: the summary
 * Rust makes (`kriyon_remote::device_view::ReadableSummary`, field for
 * field). Imports nothing, so the desktop's Other computers view and the
 * phone app (mobile/app) share it.
 */

/** One entry's content, by kind. */
export type ShownKind =
  | { kind: "you"; text: string }
  | { done: boolean; kind: "claude"; text: string }
  | {
      kind: "step";
      name: string;
      state: "running" | "done" | "failed";
      target: string;
    }
  | { kind: "report"; outcome: string; summary: string }
  /** Only ever answered in the terminal. */
  | { header: string; kind: "asking"; options: string[]; question: string }
  | { kind: "note"; text: string };

/** One entry: shown in `seq` order. */
export type ShownEntry = ShownKind & { seq: number };

/** What a readable view shows now. */
export interface ReadableSummary {
  entries: ShownEntry[];
  /** Why there are no entries, to say over the terminal; `null` while they
   *  come. */
  unavailable: string | null;
}
