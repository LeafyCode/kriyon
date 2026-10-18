#!/usr/bin/env python3
# Kriyon usage capture, run by the status-line wrapper with Claude's statusLine
# JSON on stdin. Writes two things, both owner-only and atomic (temp + rename):
#   - usage/<kriyon-session>.json: the live context reading, Kriyon sessions only,
#     and only from the session's own `claude` (see owns_session_terminal).
#   - limits/<claude-session>.json: the plan's 5-hour and weekly use, from any
#     session, because those windows belong to the account, not to a session.
# Never fails Claude: every error exits 0.
import sys, os, re, json, math, subprocess

SAFE_ID = re.compile(r"[A-Za-z0-9_-]{1,128}")


def write_private(directory, name, value):
    kriyon = os.path.join(os.path.expanduser("~"), ".claude", "kriyon")
    base = os.path.join(kriyon, directory)
    for d in (kriyon, base):
        os.makedirs(d, mode=0o700, exist_ok=True)
    tmp = os.path.join(base, name + ".json.tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        json.dump(value, f)
    os.replace(tmp, os.path.join(base, name + ".json"))


def obj(value):
    return value if isinstance(value, dict) else {}


def window(raw):
    if not isinstance(raw, dict):
        return None
    used, resets = raw.get("used_percentage"), raw.get("resets_at")
    numbers = (used, resets)
    if not all(isinstance(n, (int, float)) and math.isfinite(n) for n in numbers):
        return None
    return {"used_percentage": used, "resets_at": int(resets)}


def owns_session_terminal():
    """Whether the `claude` running this script is the session's own.

    Every process the session's `claude` starts inherits KRIYON_SESSION, so a
    `claude` run from a Bash command or a test script would speak for the
    session too. Gates only the session's own reading: plan limits belong to
    the account and record from every `claude`. Only the session's own `claude` holds the foreground of the
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



try:
    data = json.load(sys.stdin)
except Exception:
    sys.exit(0)
if not isinstance(data, dict):
    sys.exit(0)

sid = sys.argv[1] if len(sys.argv) > 1 else os.environ.get("KRIYON_SESSION", "")
claude_id = data.get("session_id")
if not isinstance(claude_id, str):
    claude_id = ""

if SAFE_ID.fullmatch(sid) and owns_session_terminal():
    cw = obj(data.get("context_window"))
    model = obj(data.get("model"))
    snap = {
        "usedPercentage": cw.get("used_percentage"),
        "contextWindowSize": cw.get("context_window_size"),
        # Tokens in the context window now, from the last API response.
        "inputTokens": cw.get("total_input_tokens"),
        "outputTokens": cw.get("total_output_tokens"),
        "model": model.get("display_name"),
        # Claude's own session id for the main interactive agent. Only the main
        # TUI renders a status line (a one-shot `claude -p` and subagents do
        # not), so this authoritatively identifies the terminal's main session.
        "sessionId": claude_id,
    }
    try:
        write_private("usage", sid, snap)
    except Exception:
        pass

# Claude sends `rate_limits` only on a Pro/Max login, after the first reply.
limits = data.get("rate_limits")
if isinstance(limits, dict) and SAFE_ID.fullmatch(claude_id):
    reading = {
        k: w for k in ("five_hour", "seven_day") if (w := window(limits.get(k)))
    }
    if reading:
        try:
            write_private("limits", claude_id, reading)
        except Exception:
            pass
sys.exit(0)
