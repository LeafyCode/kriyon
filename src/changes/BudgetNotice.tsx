//! The [Working-tree budget]'s two user-facing states, extracted from
//! [`ChangesView`] so its render stays inside the cognitive-complexity budget
//! and so the pair lives in one place: they are mutually exclusive halves of
//! the same question — "is this diff showing everything, and if not, why?"

import { type CSSProperties, Fragment } from "react";

import { button } from "../theme/recipes.ts";
import { tokens } from "../theme/tokens.ts";
import type { SessionDiff } from "../types.ts";
import { banner } from "./banner.ts";

/**
 * The [File viewer]'s warn banner, grown into a block: an over-budget tree is
 * a state the view chose, not a failure it hit, so it wears the same amber as
 * every other "this isn't the whole story" strip — but the remedy names
 * directories and offers an action, which needs more than one 34px line.
 *
 * `alignItems: start` and `display: grid` are the whole of the override: a
 * centred flex row is right for a sentence, wrong for a stack.
 */
const overBudgetStyle: CSSProperties = {
  ...banner("warn"),
  alignItems: "start",
  display: "grid",
  fontSize: "12.5px",
  gap: tokens.space.xs,
  lineHeight: 1.5,
  padding: tokens.space.md,
};

const pathStyle: CSSProperties = {
  color: tokens.color.ink.secondary,
  fontFamily: tokens.font.mono,
};

/** Mirrors SummaryBar's refresh control: the notice tells the user to refresh,
 * so it has to be able to. */
const refreshButtonStyle: CSSProperties = {
  ...button("secondary", "sm"),
  alignSelf: "start",
  marginTop: tokens.space.xs,
};

/** Not a banner: nothing is wrong and there is nothing to do — a handful of
 * untracked files had no content to diff. A quiet line is the honest weight
 * for it; `muted` rather than `faint` only because it still has to be read. */
const omittedStyle: CSSProperties = {
  color: tokens.color.ink.muted,
  fontSize: "11.5px",
  padding: `0 ${tokens.space.md} ${tokens.space.sm}`,
};

/**
 * What the [Changes view] says when a diff is not the whole story.
 *
 * Two states, checked in this order because the first subsumes the second:
 *
 * - **Over budget** — the untracked half was skipped wholesale. Says so, and
 *   names the directories to gitignore, because that is the entire fix and a
 *   bare count is a dead end.
 * - **Omitted** — the diff is otherwise complete, but some untracked files
 *   carried no content (binary, over the per-file cap, or past the byte
 *   ceiling). Counted rather than silently dropped: a review surface must not
 *   imply it showed everything.
 *
 * Renders nothing for an ordinary diff, which is the overwhelmingly common
 * case — this must be invisible until it isn't.
 */
export function BudgetNotice({
  diff,
  onRefresh,
}: {
  diff: SessionDiff | null | undefined;
  onRefresh: () => void;
}) {
  const overBudget = diff?.budgetExceeded;
  if (overBudget) {
    return (
      <div data-testid="changes-over-budget" style={overBudgetStyle}>
        <span>
          This working tree has more than{" "}
          {overBudget.fileLimit.toLocaleString()} untracked files, so
          uncommitted new files are not being diffed. Tracked changes below are
          unaffected.
        </span>
        {overBudget.untrackedDirs.length > 0 ? (
          // "Untracked directories include", not "mostly": these are a prefix
          // of git's sorted listing, not a ranking by size — see
          // `BudgetExceeded.untrackedDirs`. Claiming they are the bulk of the
          // problem would point the user at whichever directory happens to
          // sort first.
          <span>
            Untracked directories include{" "}
            {overBudget.untrackedDirs.map((path, index) => (
              <Fragment key={path}>
                {index > 0 ? ", " : null}
                <code style={pathStyle}>{path}</code>
              </Fragment>
            ))}
            . Add the ones you don't track to{" "}
            <code style={pathStyle}>.gitignore</code>, then refresh.
          </span>
        ) : null}
        {/* Without this the notice is a dead end. Editing `.gitignore` is
            itself a working-tree change, and working-tree changes are exactly
            what the over-budget state stops refreshing on (see
            `requestRefresh`) — so the one action that fixes the problem cannot
            re-arm the view that reports it. */}
        <button
          className="kr-hover-surface"
          data-testid="changes-over-budget-refresh"
          onClick={onRefresh}
          style={refreshButtonStyle}
          type="button"
        >
          Refresh
        </button>
      </div>
    );
  }

  const omitted = diff?.omittedUntracked ?? 0;
  if (omitted > 0) {
    // "not text, too large, or a symlink" rather than the narrower "binary, or
    // too large": an untracked symlink is counted here too (it is never
    // followed, by design), and naming a reason that doesn't apply to the file
    // in question is worse than naming the category.
    return (
      <div data-testid="changes-omitted" style={omittedStyle}>
        {omitted} untracked {omitted === 1 ? "file" : "files"} not shown — not
        text, too large, or a symlink.
      </div>
    );
  }
  return null;
}
