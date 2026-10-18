#!/usr/bin/env node
/**
 * Shrinks the output of a full test run before the AI assistant sees it.
 *
 * guard-bash.mjs pipes bare `pnpm check` / `pnpm test` / `cargo test` runs
 * through this script. Short output passes untouched. Once the output grows
 * long, it switches to filtering: each failure line, with a few lines after it,
 * is written as soon as it arrives, and the last lines of the run are written
 * at the end as the summary, even where they repeat a failure already shown.
 * Same signal, far fewer tokens.
 *
 * It streams rather than waiting for the run to end, because a run that
 * outlives the Bash tool's timeout is killed, and a filter that only wrote at
 * the end would turn the partial output into none. On SIGTERM, SIGINT or SIGHUP
 * it writes what it is holding and exits.
 *
 * The run's exit code survives through `set -o pipefail` in the rewritten
 * command; this filter always exits 0.
 */
import { writeSync } from "node:fs";
import process from "node:process";
import { pathToFileURL } from "node:url";

const PASSTHROUGH_MAX_LINES = 150;
const PASSTHROUGH_MAX_BYTES = 65_536;
const TAIL_LINES = 40;
const CONTEXT_AFTER = 4;
const MAX_KEPT_FAILURE_LINES = 400;
const MAX_LINE_CHARS = 2000;

// Failure markers from Vitest, Biome, tsc, cargo and clippy. Not the bare words
// "error" or "failed": those match passing test *names* ("shows the error
// message") and would fill the budget before a real failure. Summary lines such
// as "1 failed | 600 passed" survive through the tail instead.
const FAILURE_LINE =
  /\bFAIL\b|\bFAILED\b|[✕✖✗×]|AssertionError|\berror TS\d|^error(?:\[E\d+\])?:|panicked at|Unhandled|ERR_|^not ok /;

function clip(line) {
  if (line.length <= MAX_LINE_CHARS) {
    return line;
  }
  return `${line.slice(0, MAX_LINE_CHARS)}… [${line.length - MAX_LINE_CHARS} chars clipped]`;
}

const hiddenMarker = (count) => `… [${count} lines hidden]`;

/**
 * The filter as a stream: `write(chunk)` and `end()` each return the text to
 * print now. Short output is held whole and printed unchanged by `end()`.
 */
export class OutputFilter {
  #raw = "";
  #rawLines = 0;
  #filtering = false;
  #partial = "";
  // The last TAIL_LINES lines of the run, written at the end whether or not
  // some were already written as failures: the summary is the end of the run.
  #recent = [];
  #skipped = 0;
  #total = 0;
  #contextLeft = 0;
  #keptFailureLines = 0;
  #ended = false;

  write(chunk) {
    if (!this.#filtering) {
      this.#raw += chunk;
      this.#rawLines += chunk.split("\n").length - 1;
      if (
        this.#rawLines <= PASSTHROUGH_MAX_LINES &&
        this.#raw.length <= PASSTHROUGH_MAX_BYTES
      ) {
        return "";
      }
      this.#filtering = true;
      const held = this.#raw;
      this.#raw = "";
      return `[test output filtered: failures as they come, then the last ${TAIL_LINES} lines]\n${this.#take(held)}`;
    }
    return this.#take(chunk);
  }

  end() {
    if (this.#ended) {
      return "";
    }
    this.#ended = true;
    if (!this.#filtering) {
      return this.#raw;
    }
    const out = [];
    if (this.#partial) {
      this.#line(this.#partial, out);
      this.#partial = "";
    }
    // Lines skipped since the last failure that the tail doesn't cover.
    const hidden = this.#skipped - Math.min(this.#skipped, this.#recent.length);
    if (hidden > 0) {
      out.push(hiddenMarker(hidden));
    }
    out.push(`[last ${this.#recent.length} lines of ${this.#total}]`);
    for (const line of this.#recent) {
      out.push(clip(line));
    }
    return `${out.join("\n")}\n`;
  }

  #take(chunk) {
    const lines = (this.#partial + chunk).split("\n");
    this.#partial = lines.pop() ?? "";
    const out = [];
    for (const line of lines) {
      this.#line(line, out);
    }
    return out.length > 0 ? `${out.join("\n")}\n` : "";
  }

  #line(line, out) {
    this.#total += 1;
    this.#recent.push(line);
    if (this.#recent.length > TAIL_LINES) {
      this.#recent.shift();
    }
    const budgetLeft = this.#keptFailureLines < MAX_KEPT_FAILURE_LINES;
    if (budgetLeft && FAILURE_LINE.test(line)) {
      this.#contextLeft = CONTEXT_AFTER;
    } else if (budgetLeft && this.#contextLeft > 0) {
      this.#contextLeft -= 1;
    } else {
      this.#skipped += 1;
      return;
    }
    if (this.#skipped > 0) {
      out.push(hiddenMarker(this.#skipped));
      this.#skipped = 0;
    }
    out.push(clip(line));
    this.#keptFailureLines += 1;
  }
}

/** The whole filter over finished output, for tests. */
export function filterOutput(text) {
  const filter = new OutputFilter();
  return filter.write(text) + filter.end();
}

function main() {
  const filter = new OutputFilter();
  // Synchronous writes, so nothing is left in a buffer when the process exits.
  const print = (text) => {
    if (text) {
      writeSync(1, text);
    }
  };
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) {
    process.on(signal, () => {
      print(filter.end());
      process.exit(0);
    });
  }
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => print(filter.write(chunk)));
  process.stdin.on("end", () => print(filter.end()));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main();
}
