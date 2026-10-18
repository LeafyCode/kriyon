// Kriyon Companion — a read-only mod for Kriyon's own Claude Code sessions.
//
// It tells the Kriyon app on this Mac what the session does — the rows the
// conversation keeps, Claude's reply as it streams, and which rule allowed a
// tool —
// over a Unix socket the session's Kriyon daemon serves. Nothing leaves the
// Mac.
//
// What it never does: answer for a hook, change a prompt, a tool call or a
// result, approve or block anything, register a tool (that would cost tokens
// on every request), call a model, or read credentials. Every hook passes its
// event on unchanged and posts after `next`, without waiting for the post —
// the streaming one passes each piece on as it came, the same object.

// This process's run: a restarted claude numbers its posts from 1 again, so
// readers order by (run, seq).
const run = Math.random().toString(36).slice(2, 10);
let seq = 0;
let socketPath = null;
let greeted = false;
// Whether the daemon takes partial replies (it says so on every reply): an
// older one would append each to its spool, so none is sent until it does.
let streams = false;

/** Text capped, so one huge result can't bloat the spool. */
function cap(text, max) {
  if (typeof text !== "string") {
    return;
  }
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** A row's blocks with only what the Structured view shows. */
function shrinkBlock(block) {
  if (!block || typeof block !== "object") {
    return { type: "unknown" };
  }
  switch (block.type) {
    case "text":
      return { type: "text", text: cap(block.text, 20_000) };
    case "tool_use":
      return {
        type: "tool_use",
        id: block.id,
        name: block.name,
        input: cap(JSON.stringify(block.input ?? null), 2000),
      };
    case "tool_result": {
      const content = Array.isArray(block.content)
        ? block.content
            .filter((b) => b && b.type === "text")
            .map((b) => b.text)
            .join("\n")
        : block.content;
      return {
        type: "tool_result",
        tool_use_id: block.tool_use_id,
        is_error: block.is_error === true,
        content: cap(typeof content === "string" ? content : "", 2000),
      };
    }
    default:
      // Thinking arrives without its text (the API hides it); images and
      // anything else are named, not copied.
      return { type: String(block.type) };
  }
}

function shrinkMessage(message) {
  return {
    type: message?.type,
    role: message?.role,
    name: message?.name,
    isMeta: message?.isMeta === true,
    content: Array.isArray(message?.content)
      ? message.content.map(shrinkBlock)
      : [],
  };
}

/** Send one numbered event to the app. Never rejects. */
async function send($, body) {
  try {
    if (socketPath === null) {
      socketPath = (await $.env.get("KRIYON_BRIDGE_SOCKET")) ?? "";
    }
    if (!socketPath) {
      return;
    }
    // The conversation this came from: a nested `claude -p` run in the same
    // terminal inherits the socket, and Kriyon keeps only the session's own.
    const sessionId = await $.session.id();
    const res = await $.http.fetch("http://kriyon/event", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...body, sessionId }),
      socketPath,
    });
    streams = Number(res?.headers?.["x-kriyon-bridge"] ?? 0) >= 2;
  } catch {
    // The app is the observer; a missed post never troubles the session.
  }
}

/** Post one event to the app; never awaited by a hook, never throws. */
function post($, event) {
  seq += 1;
  send($, { run, seq, ...event });
}

// The daemon keeps only the newest partial reply, so partials go one at a
// time — two on their way at once could land out of order, leaving an older
// snapshot in place — and while one is out, only the newest waiting is kept.
let partialOut = false;
let partialNext = null;

/** Post a partial reply, after any still on its way. */
function postPartial($, event) {
  seq += 1;
  partialNext = { run, seq, ...event };
  if (partialOut) {
    return;
  }
  partialOut = true;
  (async () => {
    while (partialNext !== null) {
      const body = partialNext;
      partialNext = null;
      // biome-ignore lint/performance/noAwaitInLoops: one post at a time, newest body wins.
      await send($, body);
    }
    partialOut = false;
  })();
}

/** Say hello once, with the Claude Code version, on the first event seen. */
function greet($) {
  if (greeted) {
    return;
  }
  greeted = true;
  $.session
    .version()
    .then((v) => post($, { kind: "hello", version: v?.version }))
    .catch(() => post($, { kind: "hello" }));
}

/** The fewest milliseconds between two posts of a reply as it streams. */
const PARTIAL_MS = 250;

/**
 * The main agent's reply as it streams, posted as a snapshot of the text
 * block being written at most every {@link PARTIAL_MS}: a lost post heals at
 * the next one.
 * Read-only: every chunk is passed on unchanged, the same object, so what the
 * person sees and what is recorded are exactly what the engine sent.
 */
async function* streamReply($, e, next) {
  const stream = next(e);
  if (e.agentId !== undefined) {
    // A subagent's step: passed through, nothing read.
    return yield* stream;
  }
  // The text block being written: the view shows one, the newest.
  let block = null;
  let text = "";
  let lastPost = 0;
  let dirty = false;
  const flush = (final) => {
    if (!(dirty && streams)) {
      return;
    }
    dirty = false;
    postPartial($, {
      kind: "partial",
      turnId: e.turnId,
      step: e.index,
      block,
      text: cap(text, 20_000),
      final,
    });
  };
  try {
    for await (const chunk of stream) {
      try {
        if (chunk?.kind === "text") {
          if (chunk.index !== block) {
            block = chunk.index;
            text = "";
          }
          text += chunk.text;
          dirty = true;
          const now = performance.now();
          if (now - lastPost >= PARTIAL_MS) {
            lastPost = now;
            flush(false);
          }
        } else if (chunk?.kind === "stop") {
          flush(true);
        }
      } catch {
        // Reading is best-effort; the stream itself is never touched.
      }
      yield chunk;
    }
  } finally {
    flush(true);
  }
}

export function register(on) {
  on("turn.step", streamReply);

  on("session.start", ($, e, next) => {
    greet($);
    return next(e);
  });

  on("session.append", async ($, e, next) => {
    greet($);
    const result = await next(e);
    post($, {
      kind: "row",
      uuid: e.uuid,
      agentId: e.agentId,
      door: e.door,
      origin: e.origin?.kind,
      message: shrinkMessage(result?.message ?? e.message),
    });
    return result;
  });

  on("tool.check", async ($, e, next) => {
    const result = await next(e);
    if (e.tool_use_id) {
      post($, {
        kind: "check",
        toolUseId: e.tool_use_id,
        tool: e.tool,
        decision: result?.decision,
        rule: cap(result?.rule, 300),
        reason: cap(result?.reason, 300),
      });
    }
    return result;
  });

  on("session.end", ($, e, next) => {
    post($, { kind: "end", reason: e.reason });
    return next(e);
  });
}
