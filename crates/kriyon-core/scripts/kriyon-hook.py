#!/usr/bin/env python3
# Kriyon hook — records Claude Code lifecycle events for the Kriyon GUI.
# No-op unless launched by Kriyon (KRIYON_SESSION set) from the session's own
# `claude`. Never blocks Claude.
import sys, os, json, datetime, re, subprocess


def owns_session_terminal():
    """Whether the `claude` running this script is the session's own.

    Every process the session's `claude` starts inherits KRIYON_SESSION, so a
    `claude` run from a Bash command or a test script would speak for the
    session too. Only the session's own `claude` holds the foreground of the
    session's terminal (KRIYON_TTY, set by Kriyon's daemon). Mirrors kriyon-core's
    `TerminalSeat::owns_session`; kriyon-hook.py and kriyon-usage.py carry the
    same copy. Fails open when it can't tell: a session started before Kriyon
    set KRIYON_TTY, or a CLI that sets no CLAUDE_PID.
    """
    tty = os.environ.get("KRIYON_TTY", "")
    pid = os.environ.get("CLAUDE_PID", "")
    if not tty.startswith("/dev/") or not pid.isdigit():
        return True
    try:
        row = subprocess.run(["ps", "-o", "pgid=,tpgid=,tty=", "-p", pid],
                             capture_output=True, text=True, timeout=2).stdout.split()
        pgid, foreground = int(row[0]), int(row[1])
    except Exception:
        return True
    term = row[2] if len(row) > 2 else ""
    return term == tty[len("/dev/"):] and foreground > 0 and pgid == foreground


sid = os.environ.get("KRIYON_SESSION")
if not sid or not owns_session_terminal():
    sys.exit(0)

# Redaction: best-effort removal of known secret shapes before anything is
# written. Mirrors kriyon-core's `redact` module; both are pinned by
# scripts/redaction-cases.json, so change them together.
MARK = "[REDACTED]"
TOKENS = [
    (re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|\Z)"),
     "[REDACTED PRIVATE KEY]"),
    (re.compile(r"sk-ant-[A-Za-z0-9_\-]{8,}"), MARK),
    (re.compile(r"\bsk-[A-Za-z0-9_\-]{16,}"), MARK),
    (re.compile(r"\bgh[pousr]_[A-Za-z0-9]{20,}"), MARK),
    (re.compile(r"\bgithub_pat_[A-Za-z0-9_]{20,}"), MARK),
    (re.compile(r"\bAKIA[0-9A-Z]{16}\b"), MARK),
    (re.compile(r"\bxox[abprs]-[A-Za-z0-9\-]{10,}"), MARK),
    (re.compile(r"(?i)\b(bearer\s+)[A-Za-z0-9._~+/=\-]{8,}"), r"\g<1>[REDACTED]"),
    (re.compile(r"(://[^/\s:@]+:)[^/\s@]+@"), r"\g<1>[REDACTED]@"),
]
NAMED = re.compile(r"""(?i)([A-Za-z0-9_\-]*(?:password|passwd|secret|token|api[_-]?key))(["']?\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s"',;&|]+)""")
SECRET_KEY = re.compile(r"(?i)(password|passwd|secret|token|api[_-]?key)$")


def _named(m):
    v = m.group(3)
    q = v[0] if v[:1] in ('"', "'") else ""
    return m.group(1) + m.group(2) + q + MARK + q


def redact(text):
    if not isinstance(text, str):
        return text
    for pattern, repl in TOKENS:
        text = pattern.sub(repl, text)
    return NAMED.sub(_named, text)


def scrub(value):
    """Redact every string in a JSON value; a secret-named key loses its value."""
    if isinstance(value, str):
        return redact(value)
    if isinstance(value, dict):
        return {k: MARK if isinstance(k, str) and SECRET_KEY.search(k)
                and not isinstance(v, (dict, list)) else scrub(v)
                for k, v in value.items()}
    if isinstance(value, list):
        return [scrub(v) for v in value]
    return value


def cap(text, n):
    if not isinstance(text, str):
        return None
    return text if len(text) <= n else text[:n] + "…"


try:
    data = json.load(sys.stdin)
except Exception:
    sys.exit(0)
ti = data.get("tool_input")
ti = ti if isinstance(ti, dict) else {}
# The subagent's final output, for click-to-reveal. An Agent tool_response is a
# dict that leads with the (huge) input prompt, so dumping it whole pushes the
# real answer past the cap; prefer its assistant text blocks. Cap so a large
# result never bloats the events file.
tr = data.get("tool_response")
# A background Agent returns at once with a launch receipt, not its answer:
# keep the launched agent's id (what its own tool events carry), drop the rest.
launched = None
# An id Kriyon can't read is recorded as "" — still a launch, not an answer.
if isinstance(tr, dict) and tr.get("status") == "async_launched":
    launched = tr.get("agentId") if isinstance(tr.get("agentId"), str) else ""
    tr = None
if tr is None:
    result = None
elif isinstance(tr, dict):
    content = tr.get("content")
    if isinstance(content, list):
        parts = [b.get("text", "") for b in content
                 if isinstance(b, dict) and b.get("type") == "text"]
        result = "\n".join(p for p in parts if p) or json.dumps(tr)
    else:
        result = json.dumps(tr)
else:
    result = tr if isinstance(tr, str) else json.dumps(tr)
result = cap(redact(result), 4000)
# A short human target for the tool: a file path, else a command summary.
target = cap(redact(ti.get("file_path") or ti.get("command")), 200)
# Ask payload: the Notification message, the AskUserQuestion questions (raw
# JSON, dropped when oversized so it never arrives malformed), and the plan's
# first line. Feeds the Pending-ask reconstruction in kriyon-core.
msg = cap(redact(data.get("message")), 300)
qs = ti.get("questions")
questions = json.dumps(scrub(qs)) if isinstance(qs, list) else None
if questions is not None and len(questions) > 2000:
    questions = None
# On Stop: the background work still in flight, trimmed to id + type (enough
# to tell "done" from "paused until background agents wake it").
bg = data.get("background_tasks")
if isinstance(bg, list):
    bg = [{"id": str(t.get("id", "")), "type": str(t.get("type", ""))}
          for t in bg if isinstance(t, dict)]
else:
    bg = None
plan = ti.get("plan")
if isinstance(plan, str):
    plan = redact(next((l for l in plan.splitlines() if l.strip()), "").strip())[:200] or None
else:
    plan = None
rec = {
    "event": data.get("hook_event_name", ""),
    # Claude Code's own session id. Kriyon keys its files by KRIYON_SESSION, but
    # the task store is keyed by Claude's id; the watcher learns it from here.
    "session_id": data.get("session_id"),
    "transcript_path": data.get("transcript_path"),
    "tool_name": data.get("tool_name"),
    # Correlates an Agent's PreToolUse (running) with its PostToolUse (done),
    # and carries the subagent identity + background flag for the activity view.
    "tool_use_id": data.get("tool_use_id"),
    "subagent_type": ti.get("subagent_type"),
    "description": cap(redact(ti.get("description")), 300),
    "run_in_background": ti.get("run_in_background"),
    "command": cap(redact(ti.get("command")), 2000),
    # The whole tool input for the activity log, redacted and capped.
    "input": cap(json.dumps(scrub(ti)), 2000) if ti else None,
    # The user's prompt on UserPromptSubmit, for the activity log's turn heading.
    "prompt": cap(redact(data.get("prompt")), 1000),
    "prompt_source": data.get("source") if isinstance(data.get("source"), str) else None,
    # Groups a turn's events, and says what the steps were measured against.
    "cwd": data.get("cwd"),
    "prompt_id": data.get("prompt_id"),
    "permission_mode": data.get("permission_mode"),
    "result": result,
    "launched_agent_id": launched,
    # Subagent attribution + exact timing + a tool target, for the rich view.
    "agent_id": data.get("agent_id"),
    "agent_type": data.get("agent_type"),
    "duration_ms": data.get("duration_ms"),
    "target": target,
    "message": msg,
    # Why Claude Code notified ("permission_prompt", "idle_prompt",
    # "auth_success", …). The structured replacement for matching the message
    # prose; absent on builds that predate the field.
    "notification_type": data.get("notification_type"),
    # The error kind on StopFailure (e.g. "rate_limit").
    "error": data.get("error"),
    "questions": questions,
    "plan": plan,
    # On Stop: this turn is ending again because a Stop hook resumed it, so it
    # has already been announced once.
    "stop_hook_active": data.get("stop_hook_active"),
    "background_tasks": bg,
    "ts": datetime.datetime.now(datetime.timezone.utc).isoformat(),
}
try:
    # Owner-only, like Claude Code's own transcripts: other local accounts must
    # not read logged commands. One O_APPEND write per line stays atomic.
    kriyon = os.path.join(os.path.expanduser("~"), ".claude", "kriyon")
    base = os.path.join(kriyon, "events")
    for d in (kriyon, base):
        os.makedirs(d, mode=0o700, exist_ok=True)
    fd = os.open(os.path.join(base, sid + ".jsonl"),
                 os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o600)
    try:
        os.write(fd, (json.dumps(rec) + "\n").encode("utf-8"))
    finally:
        os.close(fd)
except Exception:
    pass
sys.exit(0)
