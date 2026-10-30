/**
 * The warning a worktree session's row carries while its work isn't in the
 * base branch yet, so finished work on a side branch isn't forgotten:
 * uncommitted changes first, then commits not merged. `null` once it is.
 */
export function worktreeWorkChip(
  dirty: boolean,
  unmerged: number
): { label: string; title: string } | null {
  if (dirty) {
    return {
      label: "Not committed",
      title: "This worktree has changes that aren't committed",
    };
  }
  if (unmerged > 0) {
    return {
      label: "Not merged",
      title:
        unmerged === 1
          ? "1 commit on this branch isn't in the main branch yet"
          : `${unmerged} commits on this branch aren't in the main branch yet`,
    };
  }
  return null;
}
