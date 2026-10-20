# How to word a comment

The developer reading this is busy and may not share your first language. Write so the fix is
obvious in one read.

## Plain words

Use the simplest word that is still accurate. Only use a technical term when it is the name of
something in the code, or when no plain word means the same thing.

| Don't write | Write |
| --- | --- |
| this introduces a race condition | two things can run at once here and overwrite each other |
| the state is not idempotent | calling this twice does not give the same result |
| leverage the existing abstraction | use `SandboxRoot::resolve_new`, which already does this |
| this violates separation of concerns | this component is parsing data that the store should hand it |
| non-deterministic behaviour | it does something different each time it runs |
| the lifecycle is not properly managed | the listener is never removed |
| potential null dereference | this is undefined when the session has expired, and the next line reads from it |

Never explain a concept the reader already knows. No background, no theory, no tangents.

## Shape of a comment

Four parts, in this order. Short enough to read in one pass.

```markdown
**<one-line imperative title, under 12 words>**

<What goes wrong. One or two sentences. Name the input or the state that triggers it and
what the user or the system ends up with.>

`path/to/file.ts:42`
```suggestion
<the corrected line, only when the fix is one or two lines and you are sure>
```
```

Rules:

- **Title is an instruction, not a question.** "Resolve this path through the sandbox", not
  "Should this be sandboxed?"
- **Quote the evidence.** Point at the actual line. Never describe code you have not read.
- **One problem per comment.** Two problems means two comments.
- **Say what breaks, not that something is wrong.** "If the session was archived while this
  ran, `session` is `None` and line 45 unwraps it, so the command panics and the window
  hangs" beats "possible None unwrap".
- **Offer a suggestion block only when the fix is short and certain.** A wrong suggestion
  costs the author more than no suggestion. If the fix needs judgement, describe it in a
  sentence and let the author decide.
- **No praise, no summary of the change, no "great work".** The summary comment can note that
  something is done well; inline comments cannot.
- **Comment on the code, never the person.** "The concurrency here adds complexity without a
  performance gain" — not "why did you use threads".

## Labels

Prefix every inline comment with `issue:`. Every posted comment holds the verdict open until
its thread is resolved, so a finding you are unsure of — one that did not reach 75 — is not
sent.

A nit still goes in `findings`, marked `severity: "nit"` — the script keeps it out of the
comments and lists it in the summary, and that record is what stops the next pass raising it
again. Thoughts and praise are not findings; they go in the summary's **Notes**.

## The summary comment

The summary is a signpost, not a report. **Aim for under 300 words; 700 is a hard stop and
the script will reject the round.** Every line is one line. If a point needs a paragraph, it
is a finding, and findings go in `findings` — never here.

```markdown
## Review — pass 2

<one line: what you looked at, with the commit range>

**6 issues found.**

### Notes
<optional, a line or two: something done well, or a point you are conceding>
```

Write this part only. The script adds the rest: the comments it posted, **Additional
findings** for anything it could not anchor, **Held back** for the findings over the cap and
the nits, **Still open from earlier passes** for threads nobody has resolved, **Fixed this
pass** and **Written off** where they apply, and the verdict at the very end. Do not write
those sections yourself and do not pre-empt them — you do not know which findings anchored
until the script has run.

Rules:

- **Lead with the count of findings you sent**, not the number that got a comment. Nothing
  found → the first line is **"No new findings."** and nothing comes before it.
- **Never write a verdict.** Not "no blocking issues", not "looks good", not "ready to
  merge", not "nothing blocking the merge". Your summary reports what this pass found; the
  script counts what is still open and writes the verdict from that.
- **One line per item, everywhere.** No paragraphs, no evidence, no quoted code. Evidence
  belongs in the inline comment.
- **Keep lists short.** A wall of open items reads as noise and gets skipped, which loses
  the two that mattered.
- **Never describe a new problem here, in any words.** Not a paragraph, not a line, not
  "plus an untested route". If it is a problem with this pull request it is a finding, and it
  goes in `findings`. The script will place it. The check that rejects a round only catches a
  `file:line` you left in the prose; describing the same finding without the line number gets
  past it and the finding is lost.

Call it **pass**, not round: the pass number counts every pass on the pull request, by
anyone, so it matches what a reader sees. If earlier rounds were done by hand, say so in
the first line rather than pretending this is the first look.
