#!/usr/bin/env node
// Gathers everything a PR review needs, in one shot.
//
//   node pr-context.mjs <pr-number>            JSON on stdout
//   node pr-context.mjs <pr-number> --write    JSON to its own file; prints the path
//
// A one-line brief always goes to stderr, so the numbers that matter can be
// read without picking through the JSON.
//
// Output shape is documented in ../github.md. Nothing here talks to a model —
// it is all deterministic so the review can trust it.

import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commentableLines } from "./diff-anchors.mjs";
import { readChecks } from "./read-checks.mjs";
import {
  ciState,
  countPasses,
  myLatestState,
  ownFilesOnly,
  prChecks,
} from "./review-state.mjs";

const [, , prNumber] = process.argv;
// `--write` puts the JSON in a file of its own and prints the path. Several
// reviews run at once, in different worktrees; a shared path silently mixes
// one pull request's files into another's context.
const writeToFile = process.argv.includes("--write");

if (!(prNumber && /^\d+$/.test(prNumber))) {
  console.error("usage: pr-context.mjs <pr-number> [--write]");
  process.exit(2);
}

function gh(args, { json = false, allowFail = false } = {}) {
  try {
    const out = execFileSync("gh", args, {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
    return json ? JSON.parse(out) : out;
  } catch (error) {
    if (allowFail) {
      return null;
    }
    console.error(
      `gh ${args.join(" ")} failed:\n${error.stderr || error.message}`
    );
    process.exit(1);
  }
}

/**
 * Every page of a list endpoint, flattened.
 *
 * `--slurp` returns one array per page, and it cannot be combined with `--jq`,
 * so the shaping happens here instead.
 */
function ghList(path) {
  const pages = gh(["api", path, "--paginate", "--slurp"], {
    json: true,
    allowFail: true,
  });
  return Array.isArray(pages) ? pages.flat() : [];
}

/** owner/name of the repo the PR lives in. */
function repoSlug() {
  const { owner, name } = gh(["repo", "view", "--json", "owner,name"], {
    json: true,
  });
  return { owner: owner.login, name };
}

/**
 * Review threads opened by this reviewer, with resolution state. `null` when
 * the answer cannot be trusted: a failed query or a second page we did not
 * read. Treating either as "no open threads" would hide the comments an
 * earlier pass is still waiting on.
 */
function myThreads(owner, name, viewer) {
  const query = `
    query($owner:String!,$repo:String!,$pr:Int!){
      repository(owner:$owner,name:$repo){
        pullRequest(number:$pr){
          reviewThreads(first:100){
            pageInfo{ hasNextPage }
            nodes{
              id isResolved isOutdated path line startLine subjectType
              comments(first:1){ nodes{ databaseId author{login} body } }
            }
          }
        }
      }
    }`;
  const result = gh(
    [
      "api",
      "graphql",
      "-f",
      `query=${query}`,
      "-F",
      `owner=${owner}`,
      "-F",
      `repo=${name}`,
      "-F",
      `pr=${prNumber}`,
    ],
    { json: true, allowFail: true }
  );

  const page = result?.data?.repository?.pullRequest?.reviewThreads;
  if (!page?.nodes || page.pageInfo?.hasNextPage) {
    return null;
  }
  return page.nodes
    .map((n) => {
      const first = n.comments?.nodes?.[0];
      return {
        id: n.id,
        isResolved: n.isResolved,
        isOutdated: n.isOutdated,
        path: n.path,
        line: n.line,
        databaseId: first?.databaseId ?? null,
        author: first?.author?.login ?? null,
        body: first?.body ?? "",
      };
    })
    .filter((t) => t.author === viewer);
}

const WHITESPACE = /\s+/;

function git(args) {
  try {
    return execFileSync("git", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

/**
 * Local worktree checks — advisory for review, blocking for fix.
 *
 * `localHead` against the pull request's head is what tells pr-fix whether it
 * is about to edit the code it reviewed: a branch of the same name can be
 * behind the remote, ahead of it, or a different branch altogether.
 */
function localState(headRef, headSha) {
  const branch = git(["branch", "--show-current"]) ?? "";
  const dirty = git(["status", "--porcelain"]) ?? "";
  const localHead = git(["rev-parse", "HEAD"]);
  // Counts against the branch's upstream, after a fetch. Null when there is
  // no upstream to compare with.
  git(["fetch", "--quiet", "origin", headRef]);
  const counts = git([
    "rev-list",
    "--left-right",
    "--count",
    `HEAD...origin/${headRef}`,
  ]);
  const [ahead, behind] = counts
    ? counts.split(WHITESPACE).map(Number)
    : [null, null];
  return {
    branch,
    onPrBranch: branch === headRef,
    localHead,
    atPrHead: localHead === headSha,
    ahead,
    behind,
    dirty: dirty.length > 0,
    dirtyFiles: dirty ? dirty.split("\n").map((l) => l.slice(3)) : [],
  };
}

const { owner, name } = repoSlug();
const viewer = gh(["api", "user", "--jq", ".login"]).trim();

const pr = gh(
  [
    "pr",
    "view",
    prNumber,
    "--json",
    "number,title,body,state,isDraft,headRefOid,headRefName,baseRefName,author,url,additions,deletions,changedFiles,isCrossRepository",
  ],
  { json: true }
);

const files = ghList(`repos/${owner}/${name}/pulls/${prNumber}/files`).map(
  (f) => ({
    filename: f.filename,
    status: f.status,
    additions: f.additions,
    deletions: f.deletions,
    patch: f.patch,
  })
);

const comments = ghList(`repos/${owner}/${name}/issues/${prNumber}/comments`);
const state = myLatestState(comments, viewer);

// Rounds this reviewer ran with the skill. Reviews they left by hand before it
// existed leave no bookmark, so say so rather than calling a third pass "1".
const myEarlierReviews = ghList(
  `repos/${owner}/${name}/pulls/${prNumber}/reviews`
).filter((r) => r.user?.login === viewer).length;

// Review scope: everything on the first pass, only the new commits after that.
const prPaths = new Set(files.map((f) => f.filename));
let scope;
if (state.reviewedSha && state.reviewedSha !== pr.headRefOid) {
  const compare = gh(
    [
      "api",
      `repos/${owner}/${name}/compare/${state.reviewedSha}...${pr.headRefOid}`,
      "--jq",
      "{ahead_by, files: [.files[] | {filename, status, additions, deletions, patch}]}",
    ],
    { json: true, allowFail: true }
  );

  if (compare) {
    // A merge from the base branch drags in every file that moved on the base
    // since this branch started. Those are not part of this pull request and
    // GitHub will not take a comment on them, so reviewing them is pure cost:
    // one measured pass was handed 162 files for a 26-file change.
    const inRange = compare.files ?? [];
    const own = ownFilesOnly(inRange, prPaths);
    scope = {
      kind: "incremental",
      from: state.reviewedSha,
      to: pr.headRefOid,
      aheadBy: compare.ahead_by ?? 0,
      files: own,
      fromBaseMerge: inRange.length - own.length,
    };
  } else {
    // A rebase or force-push can orphan the commit we bookmarked. Reviewing
    // the whole pull request again is wasteful; reviewing nothing is wrong.
    scope = {
      kind: "full",
      from: pr.baseRefName,
      to: pr.headRefOid,
      aheadBy: null,
      files,
      note: `could not compare against ${state.reviewedSha.slice(0, 8)} — it is no longer on the branch, so this pass covers the whole pull request`,
    };
  }
} else if (state.reviewedSha === pr.headRefOid) {
  scope = {
    kind: "no-new-commits",
    from: state.reviewedSha,
    to: pr.headRefOid,
    aheadBy: 0,
    files: [],
  };
} else {
  scope = {
    kind: "full",
    from: pr.baseRefName,
    to: pr.headRefOid,
    aheadBy: null,
    files,
  };
}

const local = localState(pr.headRefName, pr.headRefOid);
const threadsOrNull = myThreads(owner, name, viewer);
const threadsUnreadable = threadsOrNull === null;
const threads = threadsOrNull ?? [];
const failedChecks = prChecks({
  title: pr.title,
  baseRef: pr.baseRefName,
  headRef: pr.headRefName,
  body: pr.body,
});
const ci = ciState(readChecks(prNumber));

// Passes by anyone, so the summary heading matches what a reader sees on the
// pull request. `round` stays per-person because it drives the bookmark, but
// two people each counting their own made one PR show two "round 3"s.
const passNumber = countPasses(comments) + 1;

const openThreads = threads.filter((t) => !t.isResolved);
const heldBack = state.priorFindings.filter((f) => f.heldBack).length;

/** What the reviewer needs at a glance, so nobody has to poke at the JSON. */
function briefLine() {
  const parts = [
    `PR ${pr.number} · pass ${passNumber}${passNumber === state.round + 1 ? "" : ` (yours: ${state.round + 1})`}`,
  ];

  if (scope.kind === "full") {
    parts.push(`full review · ${files.length} files`);
  } else if (scope.kind === "no-new-commits") {
    parts.push("no new commits since your last pass — nothing to review");
  } else {
    const dropped = scope.fromBaseMerge
      ? `, ${scope.fromBaseMerge} base-branch files ignored`
      : "";
    parts.push(
      scope.files.length === 0
        ? `${scope.aheadBy} new commit(s), but nothing in this pull request changed — base-branch merges only, nothing to review`
        : `${scope.aheadBy} new commit(s) · ${scope.files.length} files${dropped}`
    );
  }

  parts.push(
    threadsUnreadable
      ? "open threads UNREADABLE"
      : `${openThreads.length} open thread(s)`
  );
  parts.push(
    `CI ${ci.state}${ci.failing.length ? ` (${ci.failing.join(", ")})` : ""}`
  );
  if (failedChecks.length > 0) {
    parts.push(`${failedChecks.length} PR check(s) failing`);
  }
  if (pr.isCrossRepository) {
    parts.push("from a fork");
  }
  if (state.priorFindings.length > 0) {
    parts.push(
      `${state.priorFindings.length} prior finding(s)${heldBack ? `, ${heldBack} held back` : ""}`
    );
  }
  return parts.join(" · ");
}

const brief = briefLine();
const localNotes = [];
if (!local.onPrBranch) {
  localNotes.push(`you are on ${local.branch}, not ${pr.headRefName}`);
}
if (local.dirty) {
  localNotes.push(`${local.dirtyFiles.length} uncommitted file(s)`);
}
if (local.onPrBranch && local.behind) {
  localNotes.push(`${local.behind} commit(s) behind origin/${pr.headRefName}`);
}
if (local.onPrBranch && local.ahead) {
  localNotes.push(`${local.ahead} local commit(s) not pushed`);
}

const payload = JSON.stringify(
  {
    repo: { owner, name },
    viewer,
    pr: {
      number: pr.number,
      title: pr.title,
      body: pr.body,
      state: pr.state,
      isDraft: pr.isDraft,
      headSha: pr.headRefOid,
      headRef: pr.headRefName,
      baseRef: pr.baseRefName,
      author: pr.author?.login,
      url: pr.url,
      additions: pr.additions,
      deletions: pr.deletions,
      changedFiles: pr.changedFiles,
      // From a fork: someone else's code. Never check it out or run it.
      isFork: Boolean(pr.isCrossRepository),
    },
    // Problems with the pull request itself (title, target, AI-use answer).
    prChecks: failedChecks,
    ci,
    round: state.round + 1,
    reviewedSha: state.reviewedSha,
    priorFindings: state.priorFindings,
    priorSummaryCommentId: state.commentId,
    // True when this reviewer worked on the PR before the skill existed.
    hasEarlierManualReview: state.round === 0 && myEarlierReviews > 0,
    myEarlierReviews,
    threads,
    threadsUnreadable,
    scope,
    allFiles: files.map((f) => ({
      path: f.filename,
      status: f.status,
      additions: f.additions,
      deletions: f.deletions,
    })),
    commentableLines: commentableLines(files),
    local,
    brief,
    passNumber,
  },
  null,
  2
);

process.stderr.write(`${brief}\n`);
if (localNotes.length > 0) {
  process.stderr.write(`local: ${localNotes.join("; ")}\n`);
}
if (scope.note) {
  process.stderr.write(`note: ${scope.note}\n`);
}
for (const problem of failedChecks) {
  process.stderr.write(`pr check: ${problem}\n`);
}

if (writeToFile) {
  const path = join(
    tmpdir(),
    `pr-context-${owner}-${name}-${prNumber}-${process.pid}.json`
  );
  writeFileSync(path, payload);
  process.stdout.write(`${path}\n`);
} else {
  process.stdout.write(`${payload}\n`);
}
