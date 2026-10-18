# GitHub commands

Verified against `gh` 2.101. The scripts do all of this for you — this page is for when
something goes wrong and you need to check by hand.

## The pull request

```bash
gh pr view 97 --json number,title,state,isDraft,headRefOid,headRefName,baseRefName,author,url
gh pr diff 97                       # full diff, base to head
gh api repos/{owner}/{repo}/pulls/97/files --paginate   # per-file patch text
```

`headRefOid` is the head commit. Store it; the next round compares against it.

## Only the new commits

```bash
gh api repos/{owner}/{repo}/compare/<lastSha>...<headSha> \
  --jq '{ahead_by, files: [.files[].filename]}'
```

Add `-H "Accept: application/vnd.github.v3.diff"` for the patch text instead of JSON.

## Which lines accept a comment

A comment is only valid on a line that appears in the pull request's **own** diff
(base to head), on the `RIGHT` side. Not the incremental range — the whole pull request.
Post to a line outside it and GitHub returns 422.

Work it out from the `@@` hunk headers in each file's patch: a `+` line and a context line
each take one new-side line number; a `-` line takes none.

## Posting

One comment at a time:

```bash
gh api repos/{owner}/{repo}/pulls/97/comments --method POST --input - <<'JSON'
{ "path": "src/a.ts", "line": 42, "side": "RIGHT", "commit_id": "<head sha>", "body": "..." }
JSON
```

Multi-line: add `start_line` and `start_side`; `line` is the **last** line of the range.

File-level, no line: `"subject_type": "file"` and leave `line` out.

**Do not use the batched `POST /pulls/{n}/reviews` endpoint.** It is all-or-nothing — one bad
line number returns 422 and every comment in the batch is lost.

## Threads

Resolution state is only in GraphQL, not REST.

```bash
gh api graphql -f query='
query($owner:String!,$repo:String!,$pr:Int!){
  repository(owner:$owner,name:$repo){
    pullRequest(number:$pr){
      reviewThreads(first:100){
        nodes{ id isResolved isOutdated path line
          comments(first:1){ nodes{ databaseId author{login} body } } }
      }
    }
  }
}' -F owner=OWNER -F repo=REPO -F pr=97
```

Resolve one:

```bash
gh api graphql -f query='mutation($id:ID!){
  resolveReviewThread(input:{threadId:$id}){ thread { id isResolved } }
}' -F id=<threadId>
```

Reply to a thread (`comment_id` must be the first comment, not a reply):

```bash
gh api repos/{owner}/{repo}/pulls/97/comments/<comment_id>/replies \
  --method POST -f body="..."
```

## Where the state lives

In the pull request itself. The summary comment ends with:

```
<!-- pr-review-state
{"version":2,"round":2,"reviewedSha":"abc123","findings":[...]}
-->
```

`process` is the pass's own record of which agents ran — finders, the architecture review,
the scorer — as `post-review.mjs` checked it.

Each finding carries `fp`, `path`, `line`, `title`, `severity` and `firstRound`, plus at most
one state flag:

- no flag — it got a comment. Its thread is the record from then on.
- `heldBack` — the cap cut it, so it has no comment and no thread.
- `unanchored` — GitHub would not take the line, so it has no comment and no thread.
- `fixed` — dealt with, with a `reason`. Set by `droppedFindings` or `fixedFindings`.

The middle two are the ones that go missing. Nothing will find them again on its own, so the
next round has to re-send or write off each one; `post-review.mjs` rejects a round that does
neither. `fixed` is what closes that loop.

`reviewedSha` is the commit whose diff was actually read. Never a later one — a bookmark on
commits nobody reviewed hides them from every run that follows.

**The bookmark belongs to whoever posted it.** `pr-context.mjs` reads only markers written by
the current user, so the author's `pr-fix` run and a reviewer's `pr-review` run keep separate
places in the pull request. Sharing one marker meant either person's run silenced the other's
next round.

Find the most recent one:

```bash
gh api repos/{owner}/{repo}/issues/97/comments --paginate \
  --jq '[.[] | select(.body | contains("pr-review-state"))] | last'
```

## Pull request checks and CI

`pr-context.mjs` and `post-review.mjs` both read these, and the verdict counts them:

```bash
gh pr view 97 --json title,baseRefName,headRefName,body   # the checks in review-state.mjs prChecks()
gh pr checks 97 --json name,bucket                        # bucket: pass, fail, pending, skipping, cancel
```

`gh pr checks` exits non-zero while a check fails or is pending; the JSON is still on stdout.

No database, no local file. The pull request is the memory.
