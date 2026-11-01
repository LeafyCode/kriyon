import { Lightbulb, ListTodo, type LucideIcon, StickyNote } from "lucide-react";
import { tokens } from "../theme/tokens.ts";
import type { NoteKind } from "../types.ts";

export interface NoteKindMeta {
  color: string;
  icon: LucideIcon;
  /** Singular, for a kind picker: "Todo". */
  label: string;
  /** Placeholder for the capture box while this kind is picked. */
  placeholder: string;
  /** Plural, for a filter: "Todos". */
  plural: string;
}

/** The order kinds are offered in, everywhere. */
export const NOTE_KINDS: readonly NoteKind[] = ["todo", "idea", "note"];

export const NOTE_KIND_META: Record<NoteKind, NoteKindMeta> = {
  todo: {
    color: tokens.color.noteKind.todo,
    icon: ListTodo,
    label: "Todo",
    placeholder: "Add a todo…",
    plural: "Todos",
  },
  idea: {
    color: tokens.color.noteKind.idea,
    icon: Lightbulb,
    label: "Idea",
    placeholder: "Jot down an idea…",
    plural: "Ideas",
  },
  note: {
    color: tokens.color.noteKind.note,
    icon: StickyNote,
    label: "Note",
    placeholder: "Write a note…",
    plural: "Notes",
  },
};
