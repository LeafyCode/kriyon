import { tokens } from "../theme/tokens.ts";
import type { FileChange } from "../types.ts";

/**
 * How each kind of change marks a file in the Files view — the git colours
 * and letters every editor's explorer uses. One map for the changes lists
 * and the All-files tree, so a file looks the same in every tab.
 */
export const GIT_INK: Record<FileChange, string> = {
  added: tokens.color.add,
  deleted: tokens.color.del,
  modified: tokens.color.mod,
  renamed: tokens.color.mod,
};

export const GIT_LETTER: Record<FileChange, string> = {
  added: "A",
  deleted: "D",
  modified: "M",
  renamed: "R",
};

export const GIT_LABEL: Record<FileChange, string> = {
  added: "Added",
  deleted: "Deleted",
  modified: "Modified",
  renamed: "Renamed",
};
