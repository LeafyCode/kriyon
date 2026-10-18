// The bookkeeping a repeatable review needs: whose bookmark is whose, what has
// already been raised, and whether the summary is hiding a finding in prose.
//
// Everything here is pure so it can be tested without touching GitHub.

export const STATE_MARKER = "pr-review-state";

const MARKER_BLOCK = new RegExp(`<!--\\s*${STATE_MARKER}\\s*([\\s\\S]*?)-->`);

// `path/to/file.ts:42`, `File.kt:492` — a file with an extension and a line.
const CITATION = /([\w./@-]+\.[a-zA-Z]{1,6}):(\d+)/g;

const NOT_WORD_OR_SPACE = /[^a-z0-9 ]/g;
const RUN_OF_SPACE = /\s+/g;
const CODE_FENCE = /```[\s\S]*?```/g;
const CODE_SPAN = /`[^`\n]*`/g;
const ANY_SPACE = /\s+/;

/** Words in a block of markdown, ignoring code fences and the state marker. */
export function wordCount(text) {
  return (text ?? "")
    .replace(CODE_FENCE, " ")
    .replace(MARKER_BLOCK, " ")
    .split(ANY_SPACE)
    .filter(Boolean).length;
}

/** The state blob inside a summary comment, or null if there isn't one. */
export function parseState(body) {
  const match = (body ?? "").match(MARKER_BLOCK);
  if (!match) {
    return null;
  }
  try {
    return JSON.parse(match[1].trim());
  } catch {
    return null;
  }
}

/**
 * The reviewer's own most recent bookmark.
 *
 * Scoped to one person on purpose. The author running `pr-fix` and a reviewer
 * running `pr-review` are two different readers of the same pull request, and
 * one must never move the other's place — that silently hides commits the
 * reviewer has not seen.
 */
export function myLatestState(comments, viewer) {
  const mine = (comments ?? []).filter(
    (c) => c.user?.login === viewer && c.body?.includes(STATE_MARKER)
  );
  if (mine.length === 0) {
    return { round: 0, reviewedSha: null, priorFindings: [], commentId: null };
  }

  const latest = mine.reduce((a, b) => (a.created_at > b.created_at ? a : b));
  const state = parseState(latest.body);
  return {
    round: state?.round ?? 0,
    // `lastSha` is the name the first version wrote; keep reading it.
    reviewedSha: state?.reviewedSha ?? state?.lastSha ?? null,
    priorFindings: state?.findings ?? [],
    commentId: latest.id,
  };
}

/** Stable id for a finding, so a later round knows it was already raised. */
export function fingerprint(path, title, hash) {
  const normalised = String(title)
    .toLowerCase()
    .replace(NOT_WORD_OR_SPACE, "")
    .replace(RUN_OF_SPACE, " ")
    .trim()
    .slice(0, 80);
  return hash(`${path}|${normalised}`).slice(0, 12);
}

/** Every `file.ext:line` mentioned in a block of prose. */
export function citationsIn(text) {
  const found = [];
  for (const [, path, line] of (text ?? "").matchAll(CITATION)) {
    found.push({ path, line: Number(line), basename: path.split("/").pop() });
  }
  return found;
}

function sameTarget(citation, entry) {
  const entryBase = String(entry.path ?? "")
    .split("/")
    .pop();
  return (
    entryBase === citation.basename && Number(entry.line) === citation.line
  );
}

/**
 * Findings smuggled into the summary instead of posted as comments.
 *
 * A finding described in prose gets no inline comment and no fingerprint, so
 * the next round has no memory of it. This catches that: a citation pointing
 * at a line we *could* have commented on, that no finding covers.
 *
 * Re-mentions of earlier findings are fine, and so is supporting evidence —
 * but evidence has to be declared, so that skipping a comment is a decision
 * somebody made rather than the easy path.
 */
export function proseFindings({
  summary,
  findings = [],
  priorFindings = [],
  evidenceCitations = [],
  anchors = {},
}) {
  // Prose cites the same place both ways — full path once, bare filename the
  // next time. Compare on the filename and line so they collapse to one.
  const target = (path, line) => `${String(path).split("/").pop()}:${line}`;
  const declared = new Set(
    evidenceCitations.map((c) => {
      const [path, line] = c.trim().split(":");
      return target(path, line);
    })
  );

  const anchorable = (citation) =>
    Object.entries(anchors).some(
      ([path, lines]) =>
        path.split("/").pop() === citation.basename &&
        lines.includes(citation.line)
    );

  const seen = new Set();
  const unique = citationsIn(summary).filter((citation) => {
    const key = target(citation.path, citation.line);
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });

  return unique.filter(
    (citation) =>
      !(
        declared.has(target(citation.path, citation.line)) ||
        findings.some((f) => sameTarget(citation, f)) ||
        priorFindings.some((f) => sameTarget(citation, f))
      ) && anchorable(citation)
  );
}

/** How many inline comments a pass is allowed. Five to start, three after. */
export function inlineCapFor(round) {
  return Number(round) <= 1 ? 5 : 3;
}

/**
 * Split the findings into the ones that get a comment now and the ones that wait.
 *
 * The cap exists so a human isn't buried, but a finding cut by it is still
 * real. It must not be written into the summary as prose: prose leaves no
 * fingerprint, so the next pass has no memory of it and the finding is either
 * lost or raised again as if new. Everything that waits is recorded, and it
 * takes the first comments next pass so nothing can starve.
 *
 * Nits are held back whatever the cap, and they are never promoted — a nit
 * that waits a pass is still a nit.
 */
export function splitByCap({ findings = [], cap = null, priorFindings = [] }) {
  const waited = new Set(
    priorFindings.filter((f) => f.heldBack).map((f) => f.fp)
  );

  const nits = findings.filter((f) => f.severity === "nit");
  const issues = findings.filter((f) => f.severity !== "nit");

  // Anything that already waited a pass goes first; the rest keep the order
  // the review gave them, which is worst first.
  const ranked = [
    ...issues.filter((f) => waited.has(f.fp)),
    ...issues.filter((f) => !waited.has(f.fp)),
  ];

  const limit = cap === null || cap === undefined ? ranked.length : cap;
  return {
    inline: ranked.slice(0, limit),
    heldBack: [...ranked.slice(limit), ...nits],
  };
}

// Ways a summary tries to declare the pull request fine. The verdict is
// counted from open threads, so the reviewer writing one by hand is always
// either redundant or wrong — and it was wrong the one time it mattered.
const VERDICT_PHRASES = [
  "no blocking issues",
  "nothing blocking",
  "no issues blocking",
  "ready to merge",
  "ready for merge",
  "safe to merge",
  "good to merge",
  "ok to merge",
  "clear to merge",
  "looks good to me",
  "lgtm",
];

/**
 * Verdict language the reviewer is not allowed to write.
 *
 * Code spans and fences come out first, so a summary may still name a branch,
 * a label, or a function called `lgtm` without being rejected for it. What is
 * left is matched on word boundaries, so `readyToMerge` in prose is not a
 * verdict but "ready to merge" is.
 */
export function verdictPhrasesIn(summary) {
  const text = (summary ?? "")
    .replace(CODE_FENCE, " ")
    .replace(CODE_SPAN, " ")
    .toLowerCase();
  return VERDICT_PHRASES.filter((phrase) =>
    new RegExp(`\\b${phrase.replace(RUN_OF_SPACE, "\\s+")}\\b`).test(text)
  );
}

/**
 * Issues an earlier pass found but never got a comment on, that this round
 * neither re-sent nor wrote off.
 *
 * Two kinds qualify, and they fail the same way. A `heldBack` finding was cut
 * by the cap. An `unanchored` one had no line GitHub would take. Neither has a
 * comment thread, so the only record of either is the state marker — and after
 * pass 1 the review scope is the new commits, so a bug sitting in a file
 * nobody has touched since will not be found again. Left alone it stays in the
 * state for the life of the pull request while the summary reports everything
 * is fine. Re-send it, or say why it is gone. Doing neither is not a choice
 * the reviewer gets to make quietly.
 *
 * A posted finding is not chased here: its thread is the record, and the
 * verdict counts it while it stays unresolved.
 *
 * Nits are exempt. Their record is there to stop the next pass raising them
 * again, not to bring them back.
 */
/**
 * An earlier finding that never got a comment and is still waiting: the cap
 * held it back or GitHub had no line for it, and nobody has fixed or written
 * it off. It was scored on the pass that found it.
 */
function stillCarried(f) {
  return Boolean((f.heldBack || f.unanchored) && !f.fixed);
}

export function uncommentedPriorFindings({
  priorFindings = [],
  findings = [],
  droppedFingerprints = [],
}) {
  const sent = new Set(findings.map((f) => f.fp));
  const dropped = new Set(droppedFingerprints);
  return priorFindings.filter(
    (f) =>
      stillCarried(f) &&
      f.severity !== "nit" &&
      !(sent.has(f.fp) || dropped.has(f.fp))
  );
}

/**
 * Whether the pull request is clean, worked out from what is actually open.
 *
 * The reviewer never writes this line. A pass that finds nothing new is not a
 * clean pull request: the four bugs it commented on last pass are still
 * sitting there unresolved, and printing "no blocking issues" over the top of
 * them is how a review loop stops being worth running. So the verdict is
 * counted, not written, and it counts everything that is still waiting on the
 * author — not just what this pass happened to find.
 *
 * Nits never block. Everything else does: an open comment thread from any
 * pass, a finding the cap held back, and a finding with no line to sit on.
 */
export function verdict({
  openThreads = [],
  heldBack = [],
  unanchored = [],
  threadsUnreadable = false,
  prChecks: failedChecks = [],
  ci = { state: "none", failing: [] },
} = {}) {
  const blockers = {
    openThreads: openThreads.length,
    heldBack: heldBack.filter((f) => f.severity !== "nit").length,
    unanchored: unanchored.length,
    prChecks: failedChecks.length,
    ci: ci.state === "failing" || ci.state === "pending" ? 1 : 0,
  };
  const total = Object.values(blockers).reduce((a, b) => a + b, 0);
  // Not knowing is not the same as nothing being there. A failed thread query
  // returns no threads, and counting that as a clean pull request would let a
  // network blip print the one sentence this whole verdict exists to withhold.
  // The same goes for CI: a status we could not read is not a green one.
  const ciUnreadable = ci.state === "unknown";
  return {
    ready: total === 0 && !threadsUnreadable && !ciUnreadable,
    total,
    blockers,
    threadsUnreadable,
    ciUnreadable,
    ci,
  };
}

/** The verdict as the one line that ends the summary. */
export function verdictLine(result) {
  if (result.threadsUnreadable) {
    return "**Cannot say whether this is ready.** The review threads could not be read, so there is no way to tell what is still open. Run this again.";
  }
  if (result.ciUnreadable && result.total === 0) {
    return "**Cannot say whether this is ready.** The CI status could not be read. Run this again.";
  }
  if (result.ready) {
    return "**Ready to merge, as far as this review can see.** Nothing is open from this pass or any pass before it.";
  }
  const {
    openThreads,
    unanchored,
    heldBack,
    prChecks: checks,
  } = result.blockers;
  const parts = [];
  if (result.ci?.state === "failing") {
    parts.push(`CI failing (${result.ci.failing.join(", ")})`);
  } else if (result.ci?.state === "pending") {
    parts.push("CI still running");
  }
  if (checks > 0) {
    parts.push(`${checks} pull request check(s) failing`);
  }
  if (openThreads > 0) {
    parts.push(`${openThreads} comment thread(s) still open`);
  }
  if (unanchored > 0) {
    parts.push(`${unanchored} finding(s) with no line to sit on`);
  }
  if (heldBack > 0) {
    parts.push(`${heldBack} finding(s) held back for the next pass`);
  }
  return `**Not ready to merge — ${result.total} thing(s) still open.** ${parts.join(", ")}.`;
}

/**
 * One entry per fingerprint, newest wins, keeping the round it first appeared.
 *
 * Without the merge the list grows by a copy of every earlier finding on each
 * round, and the next run sees the same thing twice.
 */
export function mergeFindings({ prior = [], current = [], round }) {
  const byFingerprint = new Map();
  for (const finding of [...prior, ...current]) {
    const firstRound =
      byFingerprint.get(finding.fp)?.firstRound ?? finding.firstRound ?? round;
    byFingerprint.set(finding.fp, { ...finding, firstRound });
  }
  return [...byFingerprint.values()];
}

/**
 * The part of a commit range that actually belongs to the pull request.
 *
 * Merging the base branch into a branch drags every file that moved on the
 * base into the next comparison. Those are not part of this pull request,
 * GitHub will not take a comment on them, and reading them is pure cost — one
 * measured pass was handed 162 files for a 26-file change.
 */
export function ownFilesOnly(rangeFiles = [], prPaths = new Set()) {
  const paths = prPaths instanceof Set ? prPaths : new Set(prPaths);
  return rangeFiles.filter((f) => paths.has(f.filename));
}

/**
 * How many passes this pull request has had, from anyone.
 *
 * The per-person `round` drives the bookmark and must stay per-person, but two
 * people each counting their own made one pull request show two "round 3"s,
 * which reads as the same work done twice.
 */
export function countPasses(comments = []) {
  return comments.filter((c) => c.body?.includes(STATE_MARKER)).length;
}

// Docs, images, config, lockfiles and repo metadata do not change the shape of
// the code. A file with no extension (CODEOWNERS, LICENSE) is metadata too.
const NOT_CODE_EXTENSION =
  /\.(md|mdx|txt|html?|pdf|png|jpe?g|gif|svg|webp|ico|ya?ml|json|toml|lock)$/i;
const HAS_EXTENSION = /\.[^/]+$/;
const notCode = (filename) =>
  NOT_CODE_EXTENSION.test(filename) || !HAS_EXTENSION.test(filename);

// A changed line that adds or drops something other code can import: a TS/JS
// export, or a public Rust item. `pub(crate)` and `pub(super)` stay inside
// their crate, so they do not count.
const EXPORT_LINE =
  /^[+-]\s*(export\b|pub\s+(?:(?:async|unsafe|const|extern)\s+)*(fn|struct|enum|trait|mod|const|static|type|use|union|impl)\b)/m;

// A Tauri command is what the frontend can call. Adding or dropping one moves
// the IPC boundary, whatever its visibility says.
const TAURI_COMMAND = /^[+-]\s*#\[tauri::command/m;

/** Whether a changed file's patch adds or drops something other code can use. */
function changesAnExport(f) {
  // GitHub leaves the patch out of very large diffs. What cannot be read
  // cannot be cleared.
  if (f.patch === undefined) {
    return (f.additions ?? 0) + (f.deletions ?? 0) > 0;
  }
  return EXPORT_LINE.test(f.patch) || TAURI_COMMAND.test(f.patch);
}

/**
 * Whether this pass has to include an architecture review, and why.
 *
 * The shape of the code changes when a file comes or goes or an export
 * changes. The first pass always counts: it is the one look at the whole pull
 * request as a shape.
 */
export function architectureReviewNeeded(scope = {}) {
  const files = scope.files ?? [];
  if (files.length === 0) {
    return { required: false, reasons: [] };
  }
  const code = files.filter((f) => !notCode(f.filename));
  if (code.length === 0) {
    return { required: false, reasons: [] };
  }
  const reasons = [];
  if (scope.kind === "full") {
    reasons.push("first look at the whole pull request");
  }
  for (const f of code) {
    if (["added", "removed", "renamed"].includes(f.status)) {
      reasons.push(`${f.filename} ${f.status}`);
    } else if (changesAnExport(f)) {
      reasons.push(`${f.filename} changes an export`);
    }
  }
  return { required: reasons.length > 0, reasons };
}

const MAIN = "main session";
const isMain = (agent) => (agent ?? "").trim().toLowerCase() === MAIN;

function briefList(items, max = 4) {
  const shown = items.slice(0, max).join("; ");
  return items.length > max
    ? `${shown}; and ${items.length - max} more`
    : shown;
}

function finderProblems(process, finders) {
  const problems = [];
  if (!finders.some((f) => !isMain(f.agent))) {
    problems.push(
      "no finder agent ran: every pass with code to review runs at least one finder agent"
    );
  }
  if (process.kind !== "fix-recheck" && finders.some((f) => isMain(f.agent))) {
    problems.push(
      "the main session was a finder: only pr-fix re-checking its own fixes may find in the main session"
    );
  }
  return problems;
}

function architectureProblems(scope, arch, finderAgents) {
  const problems = [];
  const needed = architectureReviewNeeded(scope);
  if (needed.required && !arch.ran) {
    problems.push(
      `the architecture review did not run, and this pass needs it (${briefList(needed.reasons)})`
    );
  }
  const agent = (arch.agent ?? "").trim();
  if (arch.ran && (!agent || isMain(agent) || finderAgents.has(agent))) {
    problems.push(
      "the architecture review must be its own agent, not the main session or a finder doing double duty"
    );
  }
  return problems;
}

function scorerProblems({ process, finders, arch, finderAgents, findings }) {
  const { scorer } = process;
  const agent = (scorer?.agent ?? "").trim();
  // No count given is treated as "there were candidates": the safe reading.
  const foundNothing =
    process.candidates === 0 ||
    (process.candidates === undefined &&
      finders.every((f) => f.candidates === 0) &&
      (arch.candidates ?? 0) === 0 &&
      finders.length > 0);
  const problems = [];
  if (!(foundNothing && findings.length === 0)) {
    if (!agent) {
      problems.push(
        "nothing scored the candidates: one scorer agent scores every candidate"
      );
    } else if (
      isMain(agent) ||
      finderAgents.has(agent) ||
      agent === arch.agent
    ) {
      problems.push(
        "the scorer must be a fresh agent, not the main session or one that found the candidates"
      );
    }
  }
  const sent = findings.filter((f) => f.severity !== "nit").length;
  if (typeof scorer?.kept === "number" && sent > scorer.kept) {
    problems.push(`${sent} findings sent, but the scorer kept ${scorer.kept}`);
  }
  return problems;
}

/**
 * What is wrong with how a pass was run, from the record it hands in.
 *
 * Finding, the architecture review and scoring are separate agents: a finder
 * that judges its own work talks itself into things, and a pass that skips
 * the finders only confirms old comments were fixed. The record is how that
 * gets checked instead of trusted.
 */
export function reviewProcessProblems({
  scope = {},
  process,
  findings = [],
  priorFindings = [],
}) {
  if ((scope.files ?? []).length === 0) {
    return [];
  }
  if (!process) {
    return [
      'no "process" record: say which finder agents ran, whether the architecture review ran, and who scored',
    ];
  }
  const finders = process.finders ?? [];
  const finderAgents = new Set(finders.map((f) => (f.agent ?? "").trim()));
  const arch = process.architecture ?? { ran: false };
  // A finding carried over from an earlier pass was scored then, not now.
  const earlier = new Set(priorFindings.filter(stillCarried).map((f) => f.fp));
  const scoredNow = findings.filter((f) => !earlier.has(f.fp));
  return [
    ...finderProblems(process, finders),
    ...architectureProblems(scope, arch, finderAgents),
    ...scorerProblems({
      process,
      finders,
      arch,
      finderAgents,
      findings: scoredNow,
    }),
  ];
}

/** One line for the summary, so a reader can see how the pass was run. */
export function processLine(process) {
  if (!process) {
    return "";
  }
  const finders = process.finders ?? [];
  const areas = [...new Set(finders.flatMap((f) => f.areas ?? []))];
  const parts = [
    `${finders.length} finder${finders.length === 1 ? "" : "s"}${areas.length ? ` (${areas.join(", ")})` : ""}`,
    process.architecture?.ran
      ? "architecture review"
      : "no architecture review",
  ];
  if (process.scorer) {
    const { scored, kept } = process.scorer;
    parts.push(`scorer: ${scored ?? "?"} scored, ${kept ?? "?"} kept`);
  } else {
    parts.push("nothing to score");
  }
  return `_Checked by ${parts.join(" · ")}._`;
}

// --- Pull request checks --------------------------------------------------------
//
// Things about the pull request itself rather than its code. They have no
// line to sit on, so they cannot be findings, but each one still has to be
// fixed before the merge, so the verdict counts them.

// commitlint's config-conventional: these types, an optional scope, an
// optional "!", then a lower-case subject with no full stop, 100 chars at most.
const COMMIT_TYPES =
  "build|chore|ci|docs|feat|fix|perf|refactor|revert|style|test";
const CONVENTIONAL_TITLE = new RegExp(
  `^(${COMMIT_TYPES})(\\([^()\\s][^()]*\\))?!?: (\\S.*)$`
);
const TITLE_MAX = 100;
const UPPER_START = /^[A-Z]/;
const AI_USE_BOX = /^\s*-\s*\[[ xX]\]\s*AI tools wrote most of this change/m;

const RELEASE_BRANCH = "dev";
const RELEASE_BASE = "main";

/**
 * What is wrong with the pull request itself: its title, its target, and
 * whether it answers the AI-use question.
 *
 * The title matters more than it looks. Pull requests into `dev` are
 * squash-merged, so the title becomes the commit message, and the release
 * tooling reads those messages to build the changelog and pick the version.
 */
export function prChecks({ title = "", baseRef, headRef, body } = {}) {
  const problems = [];
  const release = headRef === RELEASE_BRANCH && baseRef === RELEASE_BASE;

  const match = String(title).match(CONVENTIONAL_TITLE);
  if (!match) {
    problems.push(
      `the title is not a conventional commit ("type(scope): subject"); it becomes the squash commit message`
    );
  } else if (title.length > TITLE_MAX) {
    problems.push(
      `the title is ${title.length} characters; the limit is ${TITLE_MAX}`
    );
  } else if (UPPER_START.test(match[3]) || match[3].endsWith(".")) {
    problems.push(
      "the title's subject should start lower-case and have no full stop, as commitlint requires"
    );
  }

  if (!release && baseRef !== RELEASE_BRANCH) {
    problems.push(
      `the pull request targets ${baseRef}; work goes into ${RELEASE_BRANCH}, and only ${RELEASE_BRANCH} goes into ${RELEASE_BASE}`
    );
  }

  if (!(release || AI_USE_BOX.test(body ?? ""))) {
    problems.push(
      "the description has no AI-use checkbox; the template's checklist was removed"
    );
  }
  return problems;
}

/**
 * CI for the head commit, from `gh pr checks --json name,bucket`.
 *
 * `null` means the status could not be read, which is not the same as green.
 */
export function ciState(checks) {
  if (!Array.isArray(checks)) {
    return { state: "unknown", failing: [] };
  }
  if (checks.length === 0) {
    return { state: "none", failing: [] };
  }
  const failing = checks
    .filter((c) => c.bucket === "fail" || c.bucket === "cancel")
    .map((c) => c.name);
  if (failing.length > 0) {
    return { state: "failing", failing };
  }
  if (checks.some((c) => c.bucket === "pending")) {
    return { state: "pending", failing: [] };
  }
  return { state: "passing", failing: [] };
}
