import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { linesFromPatch } from "./diff-anchors.mjs";
import {
  architectureReviewNeeded,
  ciState,
  citationsIn,
  countPasses,
  fingerprint,
  inlineCapFor,
  mergeFindings,
  myLatestState,
  ownFilesOnly,
  parseState,
  prChecks,
  processLine,
  proseFindings,
  reviewProcessProblems,
  STATE_MARKER,
  splitByCap,
  uncommentedPriorFindings,
  verdict,
  verdictLine,
  verdictPhrasesIn,
  wordCount,
} from "./review-state.mjs";

const sha = (s) => createHash("sha256").update(s).digest("hex");
const READY = /^\*\*Ready to merge/;
const NOT_READY = /Not ready to merge — 2 thing\(s\) still open/;
const TWO_THREADS = /2 comment thread\(s\) still open/;
const NO_LINE = /no line to sit on/;
const CANNOT_SAY = /^\*\*Cannot say whether this is ready/;
const marker = (state) =>
  `body text\n\n<!-- ${STATE_MARKER}\n${JSON.stringify(state)}\n-->`;

test("parseState reads the blob back out of a posted comment", () => {
  const state = { version: 1, round: 2, reviewedSha: "abc1234", findings: [] };
  assert.deepEqual(parseState(marker(state)), state);
});

test("parseState is null-safe on junk and on comments with no marker", () => {
  assert.equal(parseState("just a comment"), null);
  assert.equal(parseState(`<!-- ${STATE_MARKER}\n{not json\n-->`), null);
  assert.equal(parseState(undefined), null);
});

test("a bookmark belongs to the person who wrote it", () => {
  // The incident this guards against: the author ran pr-fix at 08:49 and stamped the
  // head; the reviewer's next round must not read that as its own place.
  const comments = [
    {
      id: 1,
      user: { login: "reviewer" },
      created_at: "08:29",
      body: marker({ round: 1, reviewedSha: "4f3ae0d2" }),
    },
    {
      id: 2,
      user: { login: "author" },
      created_at: "08:49",
      body: marker({ round: 2, reviewedSha: "6e6ef28b" }),
    },
  ];

  assert.equal(myLatestState(comments, "reviewer").reviewedSha, "4f3ae0d2");
  assert.equal(myLatestState(comments, "reviewer").round, 1);
  assert.equal(myLatestState(comments, "author").reviewedSha, "6e6ef28b");
});

test("no bookmark of my own means this is my first pass", () => {
  const comments = [
    {
      id: 1,
      user: { login: "someone-else" },
      created_at: "08:00",
      body: marker({ round: 4, reviewedSha: "aaa" }),
    },
  ];
  assert.deepEqual(myLatestState(comments, "me"), {
    round: 0,
    reviewedSha: null,
    priorFindings: [],
    commentId: null,
  });
});

test("the newest bookmark wins, whatever order the comments arrive in", () => {
  const comments = [
    {
      id: 2,
      user: { login: "me" },
      created_at: "09:00",
      body: marker({ round: 3, reviewedSha: "ccc" }),
    },
    {
      id: 1,
      user: { login: "me" },
      created_at: "08:00",
      body: marker({ round: 1, reviewedSha: "aaa" }),
    },
  ];
  assert.equal(myLatestState(comments, "me").reviewedSha, "ccc");
});

test("a bookmark written by the first version still reads", () => {
  const comments = [
    {
      id: 1,
      user: { login: "me" },
      created_at: "08:00",
      body: marker({ round: 1, lastSha: "legacy00" }),
    },
  ];
  assert.equal(myLatestState(comments, "me").reviewedSha, "legacy00");
});

test("citations are pulled out of prose with their line", () => {
  const found = citationsIn(
    "See `src/layout/AppShell.tsx:151` and SessionRegistry.ts:50 for this."
  );
  assert.deepEqual(
    found.map((c) => `${c.basename}:${c.line}`),
    ["AppShell.tsx:151", "SessionRegistry.ts:50"]
  );
});

test("prose that describes a postable finding is caught", () => {
  // A real pass: the one new finding was written into the summary, on a line that
  // was in the diff. No comment, no fingerprint, lost by the next round.
  const violations = proseFindings({
    summary:
      "### One new thing\n\nOpening a second window steals focus. `src/layout/AppShell.tsx:151`",
    findings: [],
    priorFindings: [],
    anchors: { "src/layout/AppShell.tsx": [149, 150, 151, 152] },
  });
  assert.equal(violations.length, 1);
  assert.equal(violations[0].line, 151);
});

test("a citation covered by a posted finding is fine", () => {
  const violations = proseFindings({
    summary: "- `AppShell.tsx:151` — second window steals focus",
    findings: [{ path: "src/layout/AppShell.tsx", line: 151 }],
    anchors: { "src/layout/AppShell.tsx": [151] },
  });
  assert.equal(violations.length, 0);
});

test("re-mentioning an earlier round's finding is fine", () => {
  const violations = proseFindings({
    summary:
      "### Still open from round 1\n- `SessionRegistry.ts:50` — helper every call site must remember",
    findings: [],
    priorFindings: [
      {
        path: "src/state/SessionRegistry.ts",
        line: 50,
      },
    ],
    anchors: {
      "src/state/SessionRegistry.ts": [50],
    },
  });
  assert.equal(violations.length, 0);
});

test("a line outside the diff is not a smuggled finding — it cannot be posted", () => {
  const violations = proseFindings({
    summary: "`daemon_rt.rs:627` — status push has no attached guard",
    findings: [],
    anchors: { "src/layout/AppShell.tsx": [151] },
  });
  assert.equal(violations.length, 0);
});

test("supporting evidence passes once it is declared", () => {
  const input = {
    summary: "Tauri strips the flag; see `scripts/sidecar-ptyd.mjs:53`.",
    findings: [],
    anchors: { "scripts/sidecar-ptyd.mjs": [53] },
  };
  assert.equal(proseFindings(input).length, 1);
  assert.equal(
    proseFindings({
      ...input,
      evidenceCitations: ["scripts/sidecar-ptyd.mjs:53"],
    }).length,
    0
  );
});

test("the same citation twice is reported once", () => {
  const violations = proseFindings({
    summary: "`a/b.ts:10` is wrong. Again: `a/b.ts:10`.",
    anchors: { "a/b.ts": [10] },
  });
  assert.equal(violations.length, 1);
});

test("findings merge by fingerprint instead of piling up", () => {
  // Re-posting the same finding used to append a second copy every round.
  const prior = [
    { fp: "aaa", path: "a.ts", line: 1, title: "One", firstRound: 1 },
  ];
  const current = [{ fp: "aaa", path: "a.ts", line: 4, title: "One" }];
  const merged = mergeFindings({ prior, current, round: 2 });

  assert.equal(merged.length, 1);
  assert.equal(merged[0].line, 4, "the newest position wins");
  assert.equal(merged[0].firstRound, 1, "but it is still known to be old");
});

test("a genuinely new finding keeps this round as its first", () => {
  const merged = mergeFindings({
    prior: [{ fp: "aaa", path: "a.ts", title: "One", firstRound: 1 }],
    current: [{ fp: "bbb", path: "b.ts", title: "Two" }],
    round: 3,
  });
  assert.equal(merged.length, 2);
  assert.equal(merged.find((f) => f.fp === "bbb").firstRound, 3);
});

test("the fingerprint ignores wording noise but not the file", () => {
  assert.equal(
    fingerprint("a.ts", "Scope this query to the org", sha),
    fingerprint("a.ts", "**Scope this query to the org**  ", sha)
  );
  assert.notEqual(
    fingerprint("a.ts", "Scope this query", sha),
    fingerprint("b.ts", "Scope this query", sha)
  );
});

test("word count ignores code blocks so evidence is not punished", () => {
  assert.equal(wordCount("one two three"), 3);
  assert.equal(wordCount("one two\n```\nlots of code in here\n```\nthree"), 3);
});

test("anchors follow the new side of a hunk", () => {
  // Declared +5,9 must produce exactly lines 5-13.
  const patch = [
    "@@ -5,22 +5,9 @@ import { tokens } from '../theme/tokens';",
    " import { Panel } from 'react-resizable-panels';",
    " import { useStore } from 'zustand';",
    " import { X } from 'lucide-react';",
    "-import Icon from '../icon.svg';",
    " import logo from '../logo.png';",
    " ",
    " interface Props {",
    "-  badge?: number | null;",
    "+  sessionId: string;",
    "+  name: string;",
    " }",
  ].join("\n");

  assert.deepEqual(linesFromPatch(patch), [5, 6, 7, 8, 9, 10, 11, 12, 13]);
});

test("a file with no patch text has nowhere to comment", () => {
  assert.deepEqual(linesFromPatch(null), []);
  assert.deepEqual(linesFromPatch(""), []);
});

test("the same line cited two ways is one finding, not two", () => {
  // Prose mixes full paths and bare filenames for the same place.
  const violations = proseFindings({
    summary: "`src/layout/AppShell.tsx:151` ... later just `AppShell.tsx:151`",
    anchors: { "src/layout/AppShell.tsx": [151] },
  });
  assert.equal(violations.length, 1);
});

test("evidence declared with a full path silences the bare-name mention too", () => {
  const violations = proseFindings({
    summary: "see `apps/a/b.ts:5` and again `b.ts:5`",
    evidenceCitations: ["apps/a/b.ts:5"],
    anchors: { "apps/a/b.ts": [5] },
  });
  assert.equal(violations.length, 0);
});

const issue = (n) => ({
  fp: `fp${n}`,
  path: `a${n}.ts`,
  line: n,
  title: `Issue ${n}`,
  severity: "important",
});

test("the cap decides what goes inline; the rest is kept, not dropped", () => {
  // The PR 97 incident: 5 real findings, 1 posted, 4 written into the summary
  // as prose. Prose leaves no fingerprint, so the next pass forgets them.
  const { inline, heldBack } = splitByCap({
    findings: [issue(1), issue(2), issue(3), issue(4), issue(5)],
    cap: 3,
  });

  assert.deepEqual(
    inline.map((f) => f.fp),
    ["fp1", "fp2", "fp3"],
    "worst first, as the review ranked them"
  );
  assert.deepEqual(
    heldBack.map((f) => f.fp),
    ["fp4", "fp5"],
    "the rest come back, they are not lost"
  );
});

test("a finding held back last pass gets the first comment this pass", () => {
  // Otherwise a busy pass could starve the same finding forever.
  const { inline, heldBack } = splitByCap({
    findings: [issue(1), issue(2), issue(3)],
    cap: 2,
    priorFindings: [{ fp: "fp3", heldBack: true }],
  });

  assert.deepEqual(
    inline.map((f) => f.fp),
    ["fp3", "fp1"]
  );
  assert.deepEqual(
    heldBack.map((f) => f.fp),
    ["fp2"]
  );
});

test("nits never go inline, even when the round has room", () => {
  const { inline, heldBack } = splitByCap({
    findings: [{ ...issue(1), severity: "nit" }, issue(2)],
    cap: 5,
  });

  assert.deepEqual(
    inline.map((f) => f.fp),
    ["fp2"]
  );
  assert.deepEqual(
    heldBack.map((f) => f.fp),
    ["fp1"]
  );
});

test("a nit held back before is still never promoted to a comment", () => {
  const { inline, heldBack } = splitByCap({
    findings: [{ ...issue(1), severity: "nit" }],
    cap: 5,
    priorFindings: [{ fp: "fp1", heldBack: true }],
  });

  assert.deepEqual(inline, []);
  assert.deepEqual(
    heldBack.map((f) => f.fp),
    ["fp1"]
  );
});

test("no cap means everything goes inline — that is how pr-fix runs", () => {
  const { inline, heldBack } = splitByCap({
    findings: [issue(1), issue(2), issue(3), issue(4), issue(5), issue(6)],
    cap: null,
  });

  assert.equal(inline.length, 6);
  assert.deepEqual(heldBack, []);
});

test("the first pass gets five comments, later passes three", () => {
  assert.equal(inlineCapFor(1), 5);
  assert.equal(inlineCapFor(2), 3);
  assert.equal(inlineCapFor(7), 3);
});

test("a base-branch merge does not widen the review", () => {
  // A real pass: the compare range held 162 files for a 26-file pull request
  // because dev had been merged in. Only the PR's own files are reviewable.
  const prPaths = new Set(["src/a.ts", "src/b.ts"]);
  const range = [
    { filename: "src/a.ts" },
    { filename: "docs/unrelated.md" },
    { filename: ".claude/skills/pr-review/engine.md" },
    { filename: "src/b.ts" },
  ];
  const own = ownFilesOnly(range, prPaths);
  assert.deepEqual(
    own.map((f) => f.filename),
    ["src/a.ts", "src/b.ts"]
  );
});

test("a base merge that touches a PR file keeps that file", () => {
  // Conflict resolution during the merge is a real change to review.
  const own = ownFilesOnly([{ filename: "src/a.ts" }], new Set(["src/a.ts"]));
  assert.equal(own.length, 1);
});

test("an empty range stays empty rather than falling back to everything", () => {
  assert.deepEqual(ownFilesOnly([], new Set(["src/a.ts"])), []);
});

test("passes are counted across everyone, not per person", () => {
  // One pull request showed two round-1s, two round-3s and so on, because the author and
  // the reviewer each counted their own.
  const comments = [
    {
      user: { login: "reviewer" },
      body: marker({ round: 1, reviewedSha: "a" }),
    },
    { user: { login: "author" }, body: marker({ round: 1, reviewedSha: "b" }) },
    {
      user: { login: "reviewer" },
      body: marker({ round: 2, reviewedSha: "c" }),
    },
    { user: { login: "someone" }, body: "just a normal comment" },
  ];
  assert.equal(countPasses(comments), 3);
  assert.equal(myLatestState(comments, "reviewer").round, 2);
});

test("a held-back finding nobody mentioned again is caught", () => {
  // The exact way a pull request gets called clean with a known bug in it:
  // pass 1 held the finding back, pass 2 only looked at the new commits, and
  // the file with the bug was not among them.
  const prior = [
    {
      fp: "aaa",
      path: "src/a.ts",
      line: 10,
      title: "Retry never stops",
      heldBack: true,
    },
  ];
  const forgotten = uncommentedPriorFindings({
    priorFindings: prior,
    findings: [],
  });
  assert.equal(forgotten.length, 1);
  assert.equal(forgotten[0].fp, "aaa");
});

test("sending it again clears it", () => {
  const prior = [{ fp: "aaa", path: "src/a.ts", title: "x", heldBack: true }];
  assert.deepEqual(
    uncommentedPriorFindings({
      priorFindings: prior,
      findings: [{ fp: "aaa" }],
    }),
    []
  );
});

test("writing it off clears it, because somebody decided", () => {
  const prior = [{ fp: "aaa", path: "src/a.ts", title: "x", heldBack: true }];
  assert.deepEqual(
    uncommentedPriorFindings({
      priorFindings: prior,
      findings: [],
      droppedFingerprints: ["aaa"],
    }),
    []
  );
});

test("a held-back nit is not chased, and neither is one already written off", () => {
  const prior = [
    { fp: "n1", path: "src/a.ts", title: "x", heldBack: true, severity: "nit" },
    { fp: "f1", path: "src/b.ts", title: "y", heldBack: true, fixed: true },
  ];
  assert.deepEqual(
    uncommentedPriorFindings({ priorFindings: prior, findings: [] }),
    []
  );
});

test("a posted finding is not chased — its thread is the record", () => {
  const prior = [{ fp: "p1", path: "src/a.ts", title: "x" }];
  assert.deepEqual(
    uncommentedPriorFindings({ priorFindings: prior, findings: [] }),
    []
  );
});

test("nothing open means ready to merge", () => {
  const v = verdict({ openThreads: [], heldBack: [], unanchored: [] });
  assert.equal(v.ready, true);
  assert.equal(v.total, 0);
  assert.match(verdictLine(v), READY);
});

test("a thread left open by an earlier pass blocks the merge", () => {
  // This is the reported bug: pass 3 finds nothing new and calls it clean
  // while pass 1's comments are still unresolved.
  const v = verdict({
    openThreads: [{ id: "t1" }, { id: "t2" }],
    heldBack: [],
  });
  assert.equal(v.ready, false);
  assert.equal(v.total, 2);
  assert.match(verdictLine(v), NOT_READY);
  assert.match(verdictLine(v), TWO_THREADS);
});

test("a held-back issue blocks the merge but a held-back nit does not", () => {
  const nitOnly = verdict({
    heldBack: [{ severity: "nit" }, { severity: "nit" }],
  });
  assert.equal(nitOnly.ready, true);

  const withIssue = verdict({
    heldBack: [{ severity: "nit" }, { severity: "important" }],
  });
  assert.equal(withIssue.ready, false);
  assert.equal(withIssue.total, 1);
});

test("a finding with no line to sit on still blocks the merge", () => {
  const v = verdict({ unanchored: [{ path: "src/a.ts" }] });
  assert.equal(v.ready, false);
  assert.match(verdictLine(v), NO_LINE);
});

test("the verdict counts every kind of open thing at once", () => {
  const v = verdict({
    openThreads: [{ id: "t1" }],
    heldBack: [{ severity: "important" }, { severity: "nit" }],
    unanchored: [{ path: "a.ts" }],
  });
  assert.equal(v.total, 3);
  assert.deepEqual(v.blockers, {
    openThreads: 1,
    heldBack: 1,
    unanchored: 1,
    prChecks: 0,
    ci: 0,
  });
});

test("the summary may not declare the pull request fine", () => {
  // A real pass: "No blocking issues." sat one line above a still-broken finding,
  // and the pull request merged six minutes later.
  assert.deepEqual(
    verdictPhrasesIn("## Review — pass 2\n\n**No blocking issues.**"),
    ["no blocking issues"]
  );
  assert.deepEqual(verdictPhrasesIn("LGTM, ship it"), ["lgtm"]);
  assert.deepEqual(verdictPhrasesIn("This is ready to merge"), [
    "ready to merge",
  ]);
});

test("reporting what the pass found is still allowed", () => {
  assert.deepEqual(
    verdictPhrasesIn("**No new findings.** Read 3 commits."),
    []
  );
  assert.deepEqual(verdictPhrasesIn("**2 issues found.**"), []);
});

test("an unanchored finding from an earlier pass is chased too", () => {
  // It never got a comment either — GitHub would not take the line. Same
  // failure as a held-back one: no thread, no finder, gone.
  const prior = [
    { fp: "u1", path: "src/a.ts", line: 9, title: "x", unanchored: true },
  ];
  assert.equal(
    uncommentedPriorFindings({ priorFindings: prior, findings: [] }).length,
    1
  );
  assert.equal(
    uncommentedPriorFindings({
      priorFindings: prior,
      findings: [{ fp: "u1" }],
    }).length,
    0
  );
});

test("unreadable threads never read as ready", () => {
  // A failed GraphQL call returns no threads. Counting that as clean would let
  // a network blip print the one sentence the verdict exists to withhold.
  const v = verdict({ openThreads: [], heldBack: [], threadsUnreadable: true });
  assert.equal(v.ready, false);
  assert.equal(
    v.total,
    0,
    "nothing is known to be open, but that is not ready"
  );
  assert.match(verdictLine(v), CANNOT_SAY);
});

test("verdict phrases inside code are not a verdict", () => {
  assert.deepEqual(verdictPhrasesIn("Renamed the `lgtm` helper"), []);
  assert.deepEqual(verdictPhrasesIn("```\nconst readyToMerge = true\n```"), []);
  assert.deepEqual(verdictPhrasesIn("the readyToMergeFlag is unused"), []);
  // Still caught in ordinary prose, wrapped across a line break.
  assert.deepEqual(verdictPhrasesIn("This is ready\nto merge now"), [
    "ready to merge",
  ]);
});

// --- How the pass was run -------------------------------------------------

const NAMES_A_TS = /src\/a\.ts/;
const NEEDS_PROCESS = /process/;
const MENTIONS_FINDER = /finder/;
const MENTIONS_ARCHITECTURE = /architecture/;
const MENTIONS_SCORER = /scor/;
const MENTIONS_KEPT = /kept/;
const ONE_FINDER = /1 finder/;
const MENTIONS_MAIN_SESSION = /main session/;
const ARCHITECTURE_ANY_CASE = /architecture/i;
const SCORED_AND_KEPT = /3 scored, 1 kept/;

const file = (filename, status, patch = "@@ -1,1 +1,1 @@\n-a\n+b") => ({
  filename,
  status,
  patch,
});
const logicOnly = {
  kind: "incremental",
  files: [
    file(
      "src/a.ts",
      "modified",
      "@@ -3,1 +3,1 @@\n-  return x;\n+  return x ?? 0;"
    ),
  ],
};
const ranEverything = {
  finders: [
    { agent: "Finder: correctness and tests", areas: ["correctness", "tests"] },
  ],
  architecture: { ran: true, agent: "Architecture finder", candidates: 1 },
  scorer: { agent: "Scorer", scored: 3, kept: 1 },
};

test("a first pass always gets an architecture review", () => {
  const needed = architectureReviewNeeded({
    kind: "full",
    files: [file("src/a.ts", "modified")],
  });
  assert.equal(needed.required, true);
});

test("a later pass that adds, removes or renames a file gets an architecture review", () => {
  for (const status of ["added", "removed", "renamed"]) {
    const needed = architectureReviewNeeded({
      kind: "incremental",
      files: [file("src/new.ts", status)],
    });
    assert.equal(needed.required, true, status);
  }
});

test("a later pass that changes an export gets an architecture review", () => {
  const needed = architectureReviewNeeded({
    kind: "incremental",
    files: [
      file(
        "src/a.ts",
        "modified",
        "@@ -1,1 +1,2 @@\n export function a() {}\n+export const b = 1;"
      ),
    ],
  });
  assert.equal(needed.required, true);
  assert.match(needed.reasons.join(" "), NAMES_A_TS);
});

test("docs and images alone do not call for an architecture review", () => {
  const needed = architectureReviewNeeded({
    kind: "incremental",
    files: [file("docs/guide.md", "added"), file("assets/icon.png", "added")],
  });
  assert.equal(needed.required, false);
});

test("a later pass that only edits logic inside a function needs no architecture review", () => {
  assert.equal(architectureReviewNeeded(logicOnly).required, false);
});

test("a pass with nothing to review needs no record of how it ran", () => {
  assert.deepEqual(
    reviewProcessProblems({ scope: { kind: "no-new-commits", files: [] } }),
    []
  );
  assert.deepEqual(
    reviewProcessProblems({ scope: { kind: "incremental", files: [] } }),
    []
  );
});

test("a pass with code to review must say how it ran", () => {
  const problems = reviewProcessProblems({ scope: logicOnly, findings: [] });
  assert.match(problems.join(" "), NEEDS_PROCESS);
});

test("a pass with code to review runs at least one finder", () => {
  const problems = reviewProcessProblems({
    scope: logicOnly,
    process: { ...ranEverything, finders: [] },
  });
  assert.match(problems.join(" "), MENTIONS_FINDER);
});

test("the main session may only be the finder when pr-fix re-checks its own fixes", () => {
  const selfFound = {
    ...ranEverything,
    finders: [{ agent: "main session", areas: ["correctness"] }],
  };
  assert.match(
    reviewProcessProblems({ scope: logicOnly, process: selfFound }).join(" "),
    MENTIONS_MAIN_SESSION
  );
  assert.deepEqual(
    reviewProcessProblems({
      scope: logicOnly,
      process: {
        ...selfFound,
        kind: "fix-recheck",
        finders: [...ranEverything.finders, ...selfFound.finders],
      },
    }),
    []
  );
});

test("a pr-fix pass still runs a finder agent before it re-checks in the main session", () => {
  const problems = reviewProcessProblems({
    scope: logicOnly,
    process: {
      ...ranEverything,
      kind: "fix-recheck",
      finders: [{ agent: "main session", areas: ["correctness"] }],
    },
  });
  assert.match(problems.join(" "), MENTIONS_FINDER);
});

test("a pass that needs an architecture review cannot skip it", () => {
  const problems = reviewProcessProblems({
    scope: { kind: "full", files: [file("src/a.ts", "added")] },
    process: {
      ...ranEverything,
      architecture: { ran: false, reason: "small change" },
    },
  });
  assert.match(problems.join(" "), MENTIONS_ARCHITECTURE);
});

test("the architecture review is its own agent, not a finder doubling up", () => {
  const problems = reviewProcessProblems({
    scope: { kind: "full", files: [file("src/a.ts", "added")] },
    process: {
      ...ranEverything,
      architecture: {
        ran: true,
        agent: "Finder: correctness and tests",
        candidates: 0,
      },
    },
  });
  assert.match(problems.join(" "), MENTIONS_ARCHITECTURE);
});

test("candidates are scored by an agent that did not find them", () => {
  const noScorer = reviewProcessProblems({
    scope: logicOnly,
    process: { ...ranEverything, scorer: null },
  });
  assert.match(noScorer.join(" "), MENTIONS_SCORER);
  const selfScored = reviewProcessProblems({
    scope: logicOnly,
    process: {
      ...ranEverything,
      scorer: { agent: "Finder: correctness and tests", scored: 3, kept: 1 },
    },
  });
  assert.match(selfScored.join(" "), MENTIONS_SCORER);
  const mainScored = reviewProcessProblems({
    scope: logicOnly,
    process: {
      ...ranEverything,
      scorer: { agent: "main session", scored: 3, kept: 1 },
    },
  });
  assert.match(mainScored.join(" "), MENTIONS_SCORER);
});

test("no scorer is needed when the finders found nothing", () => {
  const problems = reviewProcessProblems({
    scope: logicOnly,
    process: {
      finders: [{ agent: "Finder", areas: ["correctness"], candidates: 0 }],
      architecture: { ran: false, reason: "logic only" },
      scorer: null,
      candidates: 0,
    },
  });
  assert.deepEqual(problems, []);
});

test("a round cannot post more findings than the scorer kept", () => {
  const problems = reviewProcessProblems({
    scope: logicOnly,
    process: ranEverything,
    findings: [{ severity: "important" }, { severity: "important" }],
  });
  assert.match(problems.join(" "), MENTIONS_KEPT);
});

test("the process line says who found, who checked the design, and who scored", () => {
  const line = processLine(ranEverything);
  assert.match(line, ONE_FINDER);
  assert.match(line, ARCHITECTURE_ANY_CASE);
  assert.match(line, SCORED_AND_KEPT);
});

test("findings carried over from an earlier pass are not counted against this pass's scorer", () => {
  const prior = [{ fp: "aaa111", severity: "important", heldBack: true }];
  const carried = [{ fp: "aaa111", severity: "important" }];
  assert.deepEqual(
    reviewProcessProblems({
      scope: logicOnly,
      process: {
        finders: [{ agent: "Finder", areas: ["correctness"], candidates: 0 }],
        architecture: { ran: false, reason: "logic only" },
        scorer: null,
      },
      findings: carried,
      priorFindings: prior,
    }),
    []
  );
  assert.deepEqual(
    reviewProcessProblems({
      scope: logicOnly,
      process: {
        ...ranEverything,
        scorer: { agent: "Scorer", scored: 1, kept: 0 },
      },
      findings: carried,
      priorFindings: prior,
    }),
    []
  );
});

test("an HTML guide alone does not call for an architecture review", () => {
  const needed = architectureReviewNeeded({
    kind: "incremental",
    files: [file("docs/guides/x.html", "added")],
  });
  assert.equal(needed.required, false);
});

test("a changed file with no patch text is treated as a possible export change", () => {
  const needed = architectureReviewNeeded({
    kind: "incremental",
    files: [
      {
        filename: "src/big.ts",
        status: "modified",
        additions: 900,
        deletions: 40,
      },
    ],
  });
  assert.equal(needed.required, true);
});

test("a fixed finding that comes back is scored again", () => {
  const problems = reviewProcessProblems({
    scope: logicOnly,
    process: {
      finders: [{ agent: "Finder", areas: ["correctness"], candidates: 0 }],
      architecture: { ran: false, reason: "logic only" },
      scorer: null,
    },
    findings: [{ fp: "abc", severity: "important" }],
    priorFindings: [{ fp: "abc", severity: "important", fixed: true }],
  });
  assert.match(problems.join(" "), MENTIONS_SCORER);
});

// --- Rust exports ------------------------------------------------------------

const rustExport = (line, filename = "crates/kriyon-core/src/lib.rs") =>
  architectureReviewNeeded({
    kind: "incremental",
    files: [file(filename, "modified", `@@ -1,1 +1,2 @@\n x\n${line}`)],
  }).required;

test("a new pub item in Rust is an export change", () => {
  for (const line of [
    "+pub fn snapshot() {}",
    "+pub struct Session {",
    "+pub enum Status {",
    "+pub trait Engine {",
    "+pub mod parser;",
    "+pub const MAX: usize = 4;",
    "+pub type Id = u64;",
    "+    pub async fn spawn(&self) {}",
  ]) {
    assert.equal(rustExport(line), true, line);
  }
});

test("private and crate-only Rust items do not change the public shape", () => {
  for (const line of [
    "+fn helper() {}",
    "+pub(crate) fn helper() {}",
    "+pub(super) struct Inner;",
    "+    let pub_count = 1;",
  ]) {
    assert.equal(rustExport(line), false, line);
  }
});

test("a new Tauri command is an export change: it widens the IPC surface", () => {
  assert.equal(
    rustExport("+#[tauri::command]", "src-tauri/src/commands.rs"),
    true
  );
});

// --- PR checks -----------------------------------------------------------------

const TEMPLATE_BODY =
  "## What changed\n\n- [x] I read and tested every line.\n- [ ] AI tools wrote most of this change.";
const goodPr = {
  title: "fix(changes): keep scroll position on reload",
  baseRef: "dev",
  headRef: "fix/scroll",
  body: TEMPLATE_BODY,
};

test("a well-formed pull request passes every check", () => {
  assert.deepEqual(prChecks(goodPr), []);
});

test("the title must be a conventional commit, because it becomes the squash commit", () => {
  for (const title of [
    "Fix scroll position",
    "fix: Keep scroll position",
    "fix(changes): keep scroll position.",
    "feature: keep scroll position",
    "fix:keep scroll position",
    `fix: ${"x".repeat(100)}`,
  ]) {
    assert.equal(prChecks({ ...goodPr, title }).length, 1, title);
  }
  for (const title of [
    "feat!: drop the old store",
    "chore(deps): bump vite",
    "docs: add community files and contributor guides",
  ]) {
    assert.deepEqual(prChecks({ ...goodPr, title }), [], title);
  }
});

test("work goes into dev, and only dev goes into main", () => {
  assert.equal(prChecks({ ...goodPr, baseRef: "main" }).length, 1);
  assert.deepEqual(
    prChecks({
      ...goodPr,
      headRef: "dev",
      baseRef: "main",
      title: "chore(release): 0.13.0",
      body: "",
    }),
    []
  );
});

test("a pull request must answer the AI-use question", () => {
  assert.equal(prChecks({ ...goodPr, body: "## What changed" }).length, 1);
  assert.equal(prChecks({ ...goodPr, body: null }).length, 1);
  assert.deepEqual(
    prChecks({ ...goodPr, body: "- [X] AI tools wrote most of this change." }),
    []
  );
});

// --- CI ------------------------------------------------------------------------

test("CI state is read from the check buckets", () => {
  assert.equal(ciState([]).state, "none");
  assert.equal(ciState(null).state, "unknown");
  assert.equal(
    ciState([
      { name: "a", bucket: "pass" },
      { name: "b", bucket: "skipping" },
    ]).state,
    "passing"
  );
  assert.equal(
    ciState([
      { name: "a", bucket: "pass" },
      { name: "b", bucket: "pending" },
    ]).state,
    "pending"
  );
  const failing = ciState([
    { name: "Rust", bucket: "fail" },
    { name: "Web", bucket: "cancel" },
    { name: "c", bucket: "pending" },
  ]);
  assert.equal(failing.state, "failing");
  assert.deepEqual(failing.failing, ["Rust", "Web"]);
});

const CI_FAILING = /CI failing \(Rust\)/;
const CI_PENDING = /CI still running/;
const PR_CHECK = /1 pull request check\(s\) failing/;

test("failing CI keeps a pull request from being ready", () => {
  const result = verdict({ ci: ciState([{ name: "Rust", bucket: "fail" }]) });
  assert.equal(result.ready, false);
  assert.match(verdictLine(result), CI_FAILING);
});

test("CI still running means not ready yet", () => {
  const result = verdict({
    ci: ciState([{ name: "Rust", bucket: "pending" }]),
  });
  assert.equal(result.ready, false);
  assert.match(verdictLine(result), CI_PENDING);
});

test("unknown CI is not the same as passing CI", () => {
  const result = verdict({ ci: ciState(null) });
  assert.equal(result.ready, false);
  assert.match(verdictLine(result), CANNOT_SAY);
});

test("a failing pull request check blocks the merge", () => {
  const result = verdict({ prChecks: ["title is not a conventional commit"] });
  assert.equal(result.ready, false);
  assert.match(verdictLine(result), PR_CHECK);
});

test("no CI at all does not block, and passing CI is ready", () => {
  assert.equal(verdict({ ci: ciState([]) }).ready, true);
  assert.equal(
    verdict({ ci: ciState([{ name: "a", bucket: "pass" }]) }).ready,
    true
  );
});

test("config, templates and extension-less files do not call for an architecture review", () => {
  const needed = architectureReviewNeeded({
    kind: "full",
    files: [
      file(".github/ISSUE_TEMPLATE/bug_report.yml", "added"),
      file(".github/CODEOWNERS", "added"),
      file(".github/workflows/stale.yml", "added"),
      file("src-tauri/capabilities/default.json", "modified"),
      file("Cargo.lock", "modified"),
      file("LICENSE", "added"),
    ],
  });
  assert.equal(needed.required, false);
});

test("a workflow beside real code still gets the review the code needs", () => {
  const needed = architectureReviewNeeded({
    kind: "full",
    files: [
      file(".github/workflows/ci.yml", "modified"),
      file("src/a.ts", "modified"),
    ],
  });
  assert.equal(needed.required, true);
});
