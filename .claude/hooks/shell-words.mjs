/**
 * Splits a Bash call into its simple commands, each as the words the shell
 * would pass to the program. The guard rules judge these words, not raw text:
 *
 *   - Quotes are honoured, so `git commit -m "explain reset --hard"` is three
 *     words after `git`, and `--hard` inside the message is not a flag. A quoted
 *     flag (`"--hard"`, `$'--hard'`) is still the word `--hard`, as git sees it.
 *   - `&&`, `||`, `;`, `|`, `&`, `(`, `)` and newlines end a command, so a flag
 *     of one command (`rm -f`) is never read as a flag of the next (`git push`).
 *     Redirections like `2>&1` stay inside their command.
 *   - Commands run inside another one are commands too: `$(…)` and backticks
 *     (also inside double quotes), and the script given to `bash -c`, `sh -c`
 *     or `eval`.
 *   - A backslash before a newline joins the two lines, as the shell does.
 *   - A `#` that starts a word starts a comment, up to the end of the line.
 *   - Heredoc bodies are dropped: they are data, so writing a doc that names a
 *     rule is not running it. `<<<` (a here-string) and the shift in
 *     `$((1<<n))` are not heredocs.
 *
 * This is a guard, not a shell. It errs towards seeing a command: anything it
 * can't classify stays an ordinary word.
 */

const HEREDOC_MARKER = /^-?\s*(["']?)([A-Za-z_]\w*)\1/;
const DIGIT = /\d/;
const SHELLS = new Set(["bash", "sh", "zsh", "dash", "ksh"]);
// Deep enough for `bash -c "echo $(git …)"`; a bound so hostile input can't loop.
const MAX_DEPTH = 8;

/** The index of the `)` that closes the `(` at `open`, or the text's end. */
function closingParen(text, open) {
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    if (text[i] === "(") {
      depth += 1;
    } else if (text[i] === ")") {
      depth -= 1;
      if (depth === 0) {
        return i;
      }
    }
  }
  return text.length;
}

class Scanner {
  constructor(text, depth) {
    this.text = text;
    this.depth = depth;
    this.i = 0;
    this.result = [];
    this.nested = [];
    this.words = [];
    this.word = "";
    this.inWord = false;
    this.heredocs = [];
  }

  run() {
    while (this.i < this.text.length) {
      this.step(this.text[this.i]);
      this.i += 1;
    }
    this.endCommand();
    return [...this.result, ...this.nested];
  }

  step(ch) {
    const next = this.text[this.i + 1];
    if (ch === "'" || ch === '"') {
      this.quoted(ch);
    } else if (ch === "$" && next === "'") {
      this.i += 1;
      this.quoted("$'");
    } else if (ch === "$" && next === "(") {
      this.substitution();
    } else if (ch === "`") {
      this.backticks();
    } else if (ch === "\\") {
      this.escape();
    } else if (ch === "#" && !this.inWord) {
      this.comment();
    } else if (ch === "<" && next === "<") {
      this.redirectIn();
    } else if (ch === "\n") {
      this.newline();
    } else if (ch === ";" || ch === "|" || ch === "(" || ch === ")") {
      this.endCommand();
    } else if (ch === "&") {
      this.ampersand();
    } else if (ch === " " || ch === "\t") {
      this.endWord();
    } else {
      this.add(ch);
    }
  }

  add(text) {
    this.word += text;
    this.inWord = true;
  }

  endWord() {
    if (this.inWord) {
      this.words.push(this.word);
    }
    this.word = "";
    this.inWord = false;
  }

  endCommand() {
    this.endWord();
    if (this.words.length > 0) {
      this.result.push(this.words);
    }
    this.words = [];
  }

  /** Scans `script` as commands of its own, run when this one runs. */
  scanNested(script) {
    if (this.depth < MAX_DEPTH) {
      this.nested.push(...commandsAt(script, this.depth + 1));
    }
  }

  /**
   * A quoted run, up to its closing quote. `'` takes everything literally; `"`
   * and `$'` honour backslashes, and `"` still runs `$(…)` and backticks.
   */
  quoted(kind) {
    this.inWord = true;
    const close = kind === "$'" ? "'" : kind;
    const { text } = this;
    for (
      this.i += 1;
      this.i < text.length && text[this.i] !== close;
      this.i += 1
    ) {
      const ch = text[this.i];
      if (kind !== "'" && ch === "\\" && this.i + 1 < text.length) {
        this.i += 1;
        this.word += text[this.i];
      } else if (kind === '"' && ch === "$" && text[this.i + 1] === "(") {
        this.substitution();
      } else if (kind === '"' && ch === "`") {
        this.backticks();
      } else {
        this.word += ch;
      }
    }
  }

  substitution() {
    const close = closingParen(this.text, this.i + 1);
    this.scanNested(this.text.slice(this.i + 2, close));
    this.add("$()");
    this.i = close;
  }

  backticks() {
    const end = this.text.indexOf("`", this.i + 1);
    const close = end === -1 ? this.text.length : end;
    this.scanNested(this.text.slice(this.i + 1, close));
    this.add("``");
    this.i = close;
  }

  escape() {
    const next = this.text[this.i + 1];
    this.i += 1;
    if (next !== undefined && next !== "\n") {
      this.add(next);
    }
  }

  /** Skips to the end of the line, leaving the newline to end the command. */
  comment() {
    const end = this.text.indexOf("\n", this.i);
    this.i = (end === -1 ? this.text.length : end) - 1;
  }

  /** `<<WORD` opens a heredoc; `<<<` and `1<<n` don't. */
  redirectIn() {
    const { text } = this;
    const afterShift = DIGIT.test(text[this.i - 1] ?? "");
    const hereString = text[this.i + 2] === "<";
    const match =
      afterShift || hereString
        ? null
        : HEREDOC_MARKER.exec(text.slice(this.i + 2));
    if (match) {
      this.endWord();
      this.heredocs.push(match[2]);
      this.i += 1 + match[0].length;
    } else {
      this.add("<<");
      this.i += 1;
    }
  }

  newline() {
    this.endCommand();
    for (const marker of this.heredocs) {
      this.skipBody(marker);
    }
    this.heredocs = [];
  }

  /** Moves past one heredoc body, ending on the newline after its marker. */
  skipBody(marker) {
    const { text } = this;
    while (this.i < text.length) {
      const end = text.indexOf("\n", this.i + 1);
      const lineEnd = end === -1 ? text.length : end;
      const line = text.slice(this.i + 1, lineEnd);
      this.i = lineEnd;
      if (line.trim() === marker) {
        return;
      }
    }
  }

  /** `&` ends a command, unless it is part of a redirection: `2>&1`, `&>f`. */
  ampersand() {
    const prev = this.text[this.i - 1];
    if (prev === ">" || prev === "<" || this.text[this.i + 1] === ">") {
      this.add("&");
    } else {
      this.endCommand();
    }
  }
}

/** The script a command hands to a shell: `bash -c "…"`, `eval …`. */
function scriptOf(words) {
  const evalAt = words.findIndex((word) => programName(word) === "eval");
  if (evalAt !== -1) {
    return words.slice(evalAt + 1).join(" ");
  }
  const shellAt = words.findIndex((word) => SHELLS.has(programName(word)));
  if (shellAt === -1) {
    return null;
  }
  const flagAt = words.indexOf("-c", shellAt + 1);
  return flagAt === -1 ? null : (words[flagAt + 1] ?? null);
}

function commandsAt(text, depth) {
  const found = new Scanner(text, depth).run();
  if (depth >= MAX_DEPTH) {
    return found;
  }
  const scripts = found.map(scriptOf).filter((script) => script !== null);
  return [...found, ...scripts.flatMap((s) => commandsAt(s, depth + 1))];
}

/** The simple commands in `text`, each a list of words with quotes removed. */
export function commands(text) {
  return typeof text === "string" ? commandsAt(text, 0) : [];
}

/** The last path part of a word: `/usr/bin/git` → `git`. */
export function programName(word) {
  return word.slice(word.lastIndexOf("/") + 1);
}
