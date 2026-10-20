#!/usr/bin/env node
// Posts a review round to a pull request. Reads one JSON object on stdin.
//
//   node post-review.mjs < round.json
//
// It checks the round before it writes anything, posts inline comments one at
// a time so a single bad anchor cannot lose the rest, resolves threads whose
// issue is now fixed, and records what was actually reviewed so the next run
// knows where to start.
//
// Input:
//   {
//     "prNumber": 97,
//     "reviewedSha": "abc123...",   // the commit whose diff you reviewed
//     "round": 2,
//     "summary": "markdown body, no state marker",
//     "priorFindings": [],          // copied straight from pr-context.mjs
//     "findings": [
//       { "path": "src/a.ts", "line": 42, "startLine": 40, "side": "RIGHT",
//         "title": "Session id read from the request body",
//         "body": "full markdown comment", "severity": "important" }
//     ],
//     "evidenceCitations": ["src/b.ts:12"],   // cited as proof, not a finding
//     "resolveThreadIds": ["PRRT_kw..."],
//     "droppedFindings": [{ "fp": "a1b2c3d4e5f6", "reason": "fixed in 4f21a9c" }],
//     "fixedFindings": [               // found and fixed in this same pass
//       { "path": "src/a.ts", "line": 42, "title": "...", "severity": "important" }
//     ],
//     "contextFile": "/tmp/.../pr-97.json",  // the file pr-context.mjs --write made
//     "process": {                   // how this pass was run — checked, then shown
//       "finders": [{ "agent": "Finder: correctness and tests",
//                     "areas": ["correctness", "tests"], "candidates": 4 }],
//       "architecture": { "ran": true, "agent": "Architecture review", "candidates": 2 },
//       "scorer": { "agent": "Scorer", "scored": 6, "kept": 2 },
//       "kind": "review"             // "fix-recheck" only for pr-fix step 5
//     },
//     "inlineCap": 5,               // omit for the default; null posts them all
//     "dryRun": false
//   }
//
// Send every finding that cleared the score bar. This script owns the cap:
// it posts the worst ones inline, records the rest so the next pass comments
// on them first, and never leaves a finding with no fingerprint.
//
// A finding an earlier pass held back never got a comment, so this pass has to
// account for it: send it again in "findings", or write it off in
// "droppedFindings" with a reason. Silence is rejected.
//
// The verdict at the end of the summary is counted here, from the comment
// threads that are still open and the findings still waiting — never written
// by the reviewer. A pass that finds nothing new is not a clean pull request.
//
// Set "dryRun": true to run every check and print the summary without writing
// anything to GitHub. Use it whenever you are unsure.
//
// Output (stdout, JSON):
//   { posted, heldBack, unanchored, resolved, summaryUrl, warnings }

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { commentableLines } from "./diff-anchors.mjs";
import { readChecks } from "./read-checks.mjs";
import {
  ciState,
  verdict as computeVerdict,
  inlineCapFor,
  fingerprint as makeFingerprint,
  mergeFindings,
  prChecks,
  processLine,
  proseFindings,
  reviewProcessProblems,
  STATE_MARKER,
  splitByCap,
  uncommentedPriorFindings,
  verdictLine,
  verdictPhrasesIn,
  wordCount,
} from "./review-state.mjs";

// A summary is a signpost, not a report. Past this it stops being read.
const SUMMARY_TARGET_WORDS = 300;
const SUMMARY_MAX_WORDS = 700;

const input = JSON.parse(readFileSync(0, "utf8"));
const {
  prNumber,
  reviewedSha,
  round,
  summary,
  findings = [],
  priorFindings = [],
  evidenceCitations = [],
  resolveThreadIds = [],
  droppedFindings = [],
  fixedFindings = [],
  contextFile,
  process: reviewProcess,
  inlineCap,
  dryRun = false,
} = input;

function fail(message, detail = "") {
  console.error(`post-review: ${message}${detail ? `\n\n${detail}` : ""}`);
  process.exit(1);
}

if (!(prNumber && reviewedSha && round)) {
  fail("input needs prNumber, reviewedSha and round");
}

function gh(args, { json = false, allowFail = false, input: stdin } = {}) {
  try {
    const out = execFileSync("gh", args, {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      input: stdin,
    });
    return json && out.trim() ? JSON.parse(out) : out;
  } catch (error) {
    if (allowFail) {
      return { __error: (error.stderr || error.message || "").trim() };
    }
    console.error(
      `gh ${args.join(" ")} failed:\n${error.stderr || error.message}`
    );
    process.exit(1);
  }
}

const sha256 = (s) => createHash("sha256").update(s).digest("hex");
const fingerprint = (path, title) => makeFingerprint(path, title, sha256);

const { owner, name } = (() => {
  const r = gh(["repo", "view", "--json", "owner,name"], { json: true });
  return { owner: r.owner.login, name: r.name };
})();

/** Every file in the pull request, with its patch text. */
function prFiles() {
  // `--slurp` returns one array per page and cannot be combined with `--jq`.
  const pages = gh(
    [
      "api",
      `repos/${owner}/${name}/pulls/${prNumber}/files`,
      "--paginate",
      "--slurp",
    ],
    { json: true }
  );
  return Array.isArray(pages) ? pages.flat() : [];
}

/**
 * This reviewer's own review threads, with resolution state. `null` when the
 * answer cannot be trusted.
 *
 * Read after the resolve step so it reflects what is actually still open, and
 * scoped to the viewer because another person's unresolved thread is not this
 * review's business.
 *
 * It must fail closed. Treating a failed query as "no open threads" would let
 * a network blip print "Ready to merge" over a pull request nobody checked —
 * the exact failure this whole verdict exists to prevent. Same for a second
 * page: threads we did not fetch are threads we cannot vouch for.
 */
function myThreads() {
  const query = `
    query($owner:String!,$repo:String!,$pr:Int!){
      repository(owner:$owner,name:$repo){
        pullRequest(number:$pr){
          reviewThreads(first:100){
            pageInfo{ hasNextPage }
            nodes{
              id isResolved path line
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
  const threads = result?.data?.repository?.pullRequest?.reviewThreads;
  if (result?.__error || !threads?.nodes) {
    return null;
  }
  if (threads.pageInfo?.hasNextPage) {
    return null;
  }
  return threads.nodes
    .map((n) => {
      const first = n.comments?.nodes?.[0];
      return {
        id: n.id,
        isResolved: n.isResolved,
        path: n.path,
        line: n.line,
        databaseId: first?.databaseId ?? null,
        author: first?.author?.login ?? null,
        body: first?.body ?? "",
      };
    })
    .filter((t) => t.author === viewer);
}

const BOLD_TITLE = /\*\*(.+?)\*\*/;

/** The bold title on the first line of a comment this skill wrote. */
function titleOf(body) {
  return (body ?? "").match(BOLD_TITLE)?.[1] ?? "";
}

const viewer = gh(["api", "user", "--jq", ".login"]).trim();
const anchors = commentableLines(prFiles());
const prNow = gh(
  [
    "pr",
    "view",
    String(prNumber),
    "--json",
    "headRefOid,headRefName,baseRefName,title,body",
  ],
  { json: true }
);
const currentHead = prNow.headRefOid;

// Read at post time, not from the context file: a title fixed or a CI run
// finished while the pass was running should show in the verdict.
const failedChecks = prChecks({
  title: prNow.title,
  baseRef: prNow.baseRefName,
  headRef: prNow.headRefName,
  body: prNow.body,
});

const ci = ciState(readChecks(prNumber));

// ---------------------------------------------------------------------------
// Check the round before writing anything. A bad round that posts half of
// itself is worse than one that never starts.
// ---------------------------------------------------------------------------

const smuggled = proseFindings({
  summary,
  findings,
  priorFindings,
  evidenceCitations,
  anchors,
});

if (smuggled.length > 0) {
  fail(
    "the summary describes findings that were never posted",
    [
      "These lines are in the diff, so a comment would have landed on them:",
      "",
      ...smuggled.map((c) => `  ${c.path}:${c.line}`),
      "",
      "A finding written into the summary gets no inline comment and no",
      "fingerprint, so the next round has no memory of it. Either move it into",
      '"findings", or, if it is only evidence for something else, declare it in',
      '"evidenceCitations".',
    ].join("\n")
  );
}

// Fingerprint up front: the carry-over check below compares this round's
// findings against what earlier rounds left waiting.
const fingerprinted = findings.map((f) => ({
  ...f,
  fp: fingerprint(f.path, f.title),
}));
// `pr-fix` finds and fixes in the same pass. Those never get a comment, but
// they still have to leave a fingerprint: six passes across two pull requests
// recorded `findings: []` and left no memory of a single thing they fixed, so
// no later pass and no second reviewer could tell what had already been dealt
// with.
const fixedRecords = fixedFindings.map((f) => ({
  fp: fingerprint(f.path, f.title),
  path: f.path,
  line: f.line,
  title: f.title,
  severity: f.severity ?? "important",
  fixed: true,
  heldBack: false,
}));

const droppedFingerprints = [
  ...droppedFindings.map((d) => d.fp),
  ...fixedRecords.map((f) => f.fp),
];

const forgotten = uncommentedPriorFindings({
  priorFindings,
  findings: fingerprinted,
  droppedFingerprints,
});

if (forgotten.length > 0) {
  fail(
    `${forgotten.length} finding(s) from an earlier pass are unaccounted for`,
    [
      "These were found and scored, but never got a comment — the cap held them",
      "back, or GitHub would not take the line — and this round did not mention",
      "them:",
      "",
      ...forgotten.map(
        (f) =>
          `  ${f.fp}  ${f.path}:${f.line} — ${f.title}${f.unanchored ? "  (no line to sit on)" : ""}`
      ),
      "",
      "After pass 1 the review scope is only the new commits, so a finder will",
      "not turn these up again on its own. Open the file, look, and then either",
      'send the finding again in "findings" with its full body, or write it off',
      'in "droppedFindings" as { "fp": "...", "reason": "..." }.',
      "",
      "Leaving them out is what lets a pull request be called clean while known",
      "bugs sit in it.",
    ].join("\n")
  );
}

const wroteVerdict = verdictPhrasesIn(summary);
if (wroteVerdict.length > 0) {
  fail(
    "the summary declares whether the pull request is mergeable",
    [
      `Found: ${wroteVerdict.map((p) => `"${p}"`).join(", ")}`,
      "",
      "The verdict is counted here, from the comment threads that are still",
      "open and the findings still waiting, and appended to the summary. A",
      "reviewer writing one by hand can only speak for the pass they just ran —",
      'and one that wrote "No blocking issues" over an unresolved thread got a',
      "pull request merged six minutes later with the bug still in it.",
      "",
      'Say what this pass found and stop. Nothing found is "No new findings."',
    ].join("\n")
  );
}

// How the pass was run is checked against what it had to review, which comes
// from the file pr-context.mjs wrote — not from the reviewer's own account.
if (!contextFile) {
  fail(
    'input needs "contextFile", the path pr-context.mjs --write printed',
    "The scope in that file decides which agents this pass had to run."
  );
}
const { scope } = JSON.parse(readFileSync(contextFile, "utf8"));
const processProblems = reviewProcessProblems({
  scope,
  process: reviewProcess,
  findings: fingerprinted,
  priorFindings,
});
if (processProblems.length > 0) {
  fail(
    "this pass skipped part of the review",
    [
      ...processProblems.map((p) => `  - ${p}`),
      "",
      "Run what is missing (engine.md step 1 and step 2), then post again with",
      'an accurate "process" record. Nothing was posted.',
    ].join("\n")
  );
}

const words = wordCount(summary);
if (words > SUMMARY_MAX_WORDS) {
  fail(
    `the summary is ${words} words (limit ${SUMMARY_MAX_WORDS})`,
    "Lead with the counts, one line per finding, and drop the rest. Long summaries go unread, which is the problem this skill exists to fix."
  );
}

const warnings = [];
if (words > SUMMARY_TARGET_WORDS) {
  warnings.push(
    `summary is ${words} words; aim for under ${SUMMARY_TARGET_WORDS}`
  );
}

// Commits that landed while this round was running were never looked at, so
// the bookmark must not claim them.
let unreviewed = null;
if (currentHead && currentHead !== reviewedSha) {
  const compare = gh(
    [
      "api",
      `repos/${owner}/${name}/compare/${reviewedSha}...${currentHead}`,
      "--jq",
      "{ahead_by, commits: [.commits[] | .sha]}",
    ],
    { json: true, allowFail: true }
  );
  const aheadBy = compare?.ahead_by ?? 0;
  if (aheadBy > 0) {
    unreviewed = { from: reviewedSha, to: currentHead, aheadBy };
    warnings.push(
      `${aheadBy} commit(s) landed while this round ran; they were not reviewed`
    );
  }
}

// ---------------------------------------------------------------------------
// Write.
// ---------------------------------------------------------------------------

// The cap keeps the author from being buried, but a finding it cuts is still
// real. Hold it back with a fingerprint rather than dropping it, so the next
// pass knows about it and comments on it first.
const { inline, heldBack } = splitByCap({
  findings: fingerprinted,
  cap: inlineCap === undefined ? inlineCapFor(round) : inlineCap,
  priorFindings,
});

const posted = [];
const unanchored = [];

for (const finding of inline) {
  const { fp, path, line, startLine, side = "RIGHT", body, title } = finding;
  const allowed = anchors[path];

  if (!allowed) {
    unanchored.push({
      ...finding,
      reason: `${path} is not part of this pull request`,
    });
    continue;
  }
  if (!allowed.includes(line)) {
    unanchored.push({
      ...finding,
      reason: `line ${line} of ${path} is not in the diff`,
    });
    continue;
  }

  const payload = { path, line, side, body, commit_id: reviewedSha };
  if (startLine && startLine !== line && allowed.includes(startLine)) {
    payload.start_line = startLine;
    payload.start_side = side;
  }

  const result = dryRun
    ? { html_url: "(dry run — not posted)" }
    : gh(
        [
          "api",
          `repos/${owner}/${name}/pulls/${prNumber}/comments`,
          "--method",
          "POST",
          "--input",
          "-",
        ],
        { json: true, allowFail: true, input: JSON.stringify(payload) }
      );

  if (result?.__error) {
    unanchored.push({
      ...finding,
      reason: `GitHub rejected it: ${result.__error.split("\n")[0]}`,
    });
  } else {
    posted.push({
      fp,
      path,
      line,
      title,
      severity: finding.severity ?? "important",
      url: result.html_url,
      // Kept so the ledger below can tell a thread opened just now from one
      // the author has been sitting on since an earlier pass.
      commentId: result.id ?? null,
    });
  }
}

const resolved = [];
for (const threadId of resolveThreadIds) {
  if (dryRun) {
    resolved.push(threadId);
    continue;
  }
  const result = gh(
    [
      "api",
      "graphql",
      "-f",
      "query=mutation($id:ID!){ resolveReviewThread(input:{threadId:$id}){ thread { id isResolved } } }",
      "-F",
      `id=${threadId}`,
    ],
    { json: true, allowFail: true }
  );
  if (!result?.__error) {
    resolved.push(threadId);
  }
}

// Read the threads *after* resolving, so what comes back is what is genuinely
// still waiting on the author. This is the part the reviewer cannot fake: a
// pass that found nothing new still has to answer for the comments earlier
// passes left open.
const threadsNow = myThreads();
const threadsUnreadable = threadsNow === null;
const justPosted = new Set(posted.map((p) => p.commentId).filter(Boolean));
const resolvedNow = new Set(resolveThreadIds);
const openThreads = (threadsNow ?? []).filter((t) => !t.isResolved);

// A dry run has to predict the real run, not flatter it. Nothing was posted,
// so this round's comments have no thread yet — count the ones that would have
// posted (`posted`, not `inline`: an anchor that fails is already counted
// under `unanchored`). The resolves did not happen either, so drop the threads
// the real run would have closed.
const openForVerdict = dryRun
  ? [...openThreads.filter((t) => !resolvedNow.has(t.id)), ...posted]
  : openThreads;
const carriedThreads = openThreads.filter(
  (t) => !(justPosted.has(t.databaseId) || (dryRun && resolvedNow.has(t.id)))
);

// Anything we could not anchor still has to reach the author — it goes in the
// summary rather than being silently dropped.
let body = summary ?? "";
if (unanchored.length > 0) {
  // The title is already the first line of the body — show the explanation.
  const explain = (f) =>
    (f.body ?? "")
      .split("\n")
      .map((l) => l.trim())
      .find(
        (l) =>
          l &&
          !l.startsWith("issue:") &&
          !l.startsWith("question:") &&
          !l.startsWith("**")
      ) ?? "";

  const items = unanchored
    .map(
      (f) =>
        `- \`${f.path}:${f.line}\` — **${f.title}**\n  ${explain(f)}\n  _(${f.reason})_`
    )
    .join("\n");
  body += `\n\n### Additional findings\n\nThese could not be attached to a line:\n\n${items}\n`;
}

// Real findings the cap could not fit. They are named here and remembered in
// the state below, so the next pass comments on them first.
if (heldBack.length > 0) {
  const issues = heldBack.filter((f) => f.severity !== "nit");
  const nits = heldBack.filter((f) => f.severity === "nit");
  const line = (f) => `- \`${f.path}:${f.line}\` — ${f.title}`;

  body += "\n\n### Held back\n";
  if (issues.length > 0) {
    body += `\nReal issues, but only ${inline.length} comment(s) go inline per pass. These get the first comments next time.\n\n${issues.map(line).join("\n")}\n`;
  }
  if (nits.length > 0) {
    body += `\nSmaller things, not worth a comment:\n\n${nits.map(line).join("\n")}\n`;
  }
}

// Comments from earlier passes the author has not dealt with yet. Naming them
// here is the whole point: without this list a pass that finds nothing new
// reads as a clean pull request while four known bugs sit in it.
if (carriedThreads.length > 0) {
  const shown = carriedThreads.slice(0, 5);
  const item = (t) =>
    `- \`${t.path}${t.line ? `:${t.line}` : ""}\` — ${titleOf(t.body) || "see the thread"}`;
  body += `\n\n### Still open from earlier passes\n\n${shown.map(item).join("\n")}\n`;
  if (carriedThreads.length > shown.length) {
    body += `\nplus ${carriedThreads.length - shown.length} more.\n`;
  }
}

if (fixedRecords.length > 0) {
  const item = (f) => `- \`${f.path}:${f.line}\` — ${f.title}`;
  body += `\n\n### Fixed this pass\n\n${fixedRecords.map(item).join("\n")}\n`;
}

if (droppedFindings.length > 0) {
  const entry = (d) => {
    const known = priorFindings.find((f) => f.fp === d.fp);
    return `- ${known ? known.title : d.fp} — ${d.reason ?? "no reason given"}`;
  };
  body += `\n\n### Written off\n\n${droppedFindings.map(entry).join("\n")}\n`;
}

if (unreviewed) {
  body += `\n\n_${unreviewed.aheadBy} commit(s) landed while this round was running (\`${unreviewed.from.slice(0, 8)}..${unreviewed.to.slice(0, 8)}\`). They were **not** reviewed — run this again to pick them up._\n`;
}

if (failedChecks.length > 0) {
  body += `\n\n### Pull request checks\n\n${failedChecks.map((p) => `- ${p}`).join("\n")}\n`;
}

// The verdict is counted, never written. It is the last thing in the summary
// because it is the conclusion of everything above it.
const checkedBy = processLine(reviewProcess);
if (checkedBy) {
  body += `\n\n${checkedBy}\n`;
}

const result = computeVerdict({
  openThreads: openForVerdict,
  heldBack,
  unanchored,
  threadsUnreadable,
  prChecks: failedChecks,
  ci,
});
body += `\n\n---\n\n${verdictLine(result)}\n`;
if (threadsUnreadable) {
  warnings.push(
    "could not read the review threads; the verdict cannot say the pull request is ready"
  );
}
if (unreviewed) {
  body += "\nThis does not account for the commits that landed mid-round.\n";
}

const state = {
  version: 2,
  round,
  // The commit whose diff was actually read. Never the head after a push:
  // that would mark commits reviewed that nobody looked at.
  reviewedSha,
  // How this pass was run, so a later reader can tell a real pass from a
  // quick look.
  process: reviewProcess ?? null,
  findings: mergeFindings({
    prior: priorFindings,
    current: [
      ...posted.map(({ fp, path, line, title, severity }) => ({
        fp,
        path,
        line,
        title,
        severity,
      })),
      ...unanchored.map((f) => ({
        fp: fingerprint(f.path, f.title),
        path: f.path,
        line: f.line,
        title: f.title,
        severity: f.severity ?? "important",
        unanchored: true,
      })),
      // Never commented on, so the next pass has to be able to find them.
      ...heldBack.map((f) => ({
        fp: f.fp,
        path: f.path,
        line: f.line,
        title: f.title,
        severity: f.severity ?? "important",
        heldBack: true,
      })),
      // Found and fixed in the same pass, so there is nothing to comment on —
      // but the record has to exist, or the next pass has no idea it happened.
      ...fixedRecords,
      // Written off on purpose. Marked so the next pass stops asking for them
      // and does not raise them again as if new.
      ...droppedFindings.flatMap((d) => {
        const known = priorFindings.find((f) => f.fp === d.fp);
        return known
          ? [{ ...known, heldBack: false, fixed: true, reason: d.reason }]
          : [];
      }),
    ],
    round,
  }),
};

body += `\n\n<!-- ${STATE_MARKER}\n${JSON.stringify(state)}\n-->`;

const summaryComment = dryRun
  ? { html_url: "(dry run — not posted)" }
  : gh(
      [
        "api",
        `repos/${owner}/${name}/issues/${prNumber}/comments`,
        "--method",
        "POST",
        "--input",
        "-",
      ],
      { json: true, input: JSON.stringify({ body }) }
    );

if (dryRun) {
  process.stderr.write(`--- summary that would be posted ---\n${body}\n---\n`);
}
for (const warning of warnings) {
  process.stderr.write(`post-review warning: ${warning}\n`);
}

process.stdout.write(
  `${JSON.stringify(
    {
      dryRun,
      posted,
      heldBack: heldBack.map((f) => ({
        path: f.path,
        line: f.line,
        title: f.title,
        severity: f.severity ?? "important",
      })),
      unanchored: unanchored.map((f) => ({
        path: f.path,
        line: f.line,
        title: f.title,
        reason: f.reason,
      })),
      resolved,
      unreviewed,
      warnings,
      verdict: {
        ...result,
        line: verdictLine(result),
        stillOpenFromEarlierPasses: carriedThreads.map((t) => ({
          path: t.path,
          line: t.line,
          title: titleOf(t.body),
        })),
      },
      summaryUrl: summaryComment.html_url,
    },
    null,
    2
  )}\n`
);
